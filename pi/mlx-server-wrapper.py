#!/usr/bin/env python3
"""
MLX-LM Server Wrapper for Qwen3.5 models.

Three monkey-patches:
  1. mlx.nn.Module.load_weights — skips vision_tower weights that ship with
     Qwen3.5 MLX models (tagged image-text-to-text on HuggingFace).
  2. mlx_lm.server.ModelProvider.load — forces any model ID in incoming
     requests to resolve to the pre-loaded default model. Without this,
     the server tries to download Pi's short model IDs (e.g. "qwen3.5-35b-a3b")
     from HuggingFace when they don't match the full repo name.
  3. mlx_lm.server.ResponseGenerator._serve_single — injects KV cache
     quantization kwargs into stream_generate so the server benefits from
     reduced memory bandwidth on long contexts.

Extra CLI flags (parsed and stripped before mlx_lm.server sees argv):
  --kv-bits N             Quantize KV cache to N bits (4 or 8). Default: off.
  --kv-group-size N       Group size for KV quantization. Default: 64.
  --quantized-kv-start N  Token offset before switching to quantized KV.
                          Default: 1024.

Usage:
    python3 mlx-server-wrapper.py [wrapper flags] [mlx_lm.server flags...]

Example:
    python3 mlx-server-wrapper.py --kv-bits 8 --quantized-kv-start 1024 \\
        --model mlx-community/Qwen3.5-35B-A3B-4bit \\
        --port 8090 --temp 0.6 --top-p 0.95 --top-k 20
"""

import sys

# ---------------------------------------------------------------------------
# 1. Parse wrapper-only flags from sys.argv before mlx_lm.server's argparse
# ---------------------------------------------------------------------------
_kv_bits = None
_kv_group_size = 64
_quantized_kv_start = 1024

_cleaned_argv = [sys.argv[0]]
i = 1
while i < len(sys.argv):
    if sys.argv[i] == "--kv-bits" and i + 1 < len(sys.argv):
        _kv_bits = int(sys.argv[i + 1])
        i += 2
    elif sys.argv[i] == "--kv-group-size" and i + 1 < len(sys.argv):
        _kv_group_size = int(sys.argv[i + 1])
        i += 2
    elif sys.argv[i] == "--quantized-kv-start" and i + 1 < len(sys.argv):
        _quantized_kv_start = int(sys.argv[i + 1])
        i += 2
    else:
        _cleaned_argv.append(sys.argv[i])
        i += 1

sys.argv = _cleaned_argv

if _kv_bits is not None:
    print(
        f"[wrapper] KV cache quantization enabled: "
        f"bits={_kv_bits}, group_size={_kv_group_size}, "
        f"quantized_kv_start={_quantized_kv_start}"
    )
else:
    print("[wrapper] KV cache quantization: off (full precision)")

# ---------------------------------------------------------------------------
# 2. Patch load_weights BEFORE any model loading happens
# ---------------------------------------------------------------------------
import mlx.nn as nn

_orig_load_weights = nn.Module.load_weights


def _filtered_load_weights(self, weights, strict=True):
    """Skip vision_tower weights that aren't part of the text-only model."""
    filtered = [
        (k, v)
        for k, v in weights
        if not k.startswith(("vision_tower.", "language_model.vision_tower."))
    ]
    return _orig_load_weights(self, filtered, strict=False)


nn.Module.load_weights = _filtered_load_weights

# ---------------------------------------------------------------------------
# 3. Patch ModelProvider.load — force all request model IDs to the default
# ---------------------------------------------------------------------------
from mlx_lm import server as _server
from mlx_lm.generate import stream_generate

_orig_model_provider_load = _server.ModelProvider.load


def _force_default_load(self, model_path, adapter_path=None, draft_model_path=None):
    """Always resolve to the pre-loaded default model.

    The MLX server's ModelProvider.load uses a default_model_map to recognize
    the CLI --model path and skip re-downloading.  Pi sends requests with
    short model IDs (e.g. "qwen3.5-35b-a3b") that are NOT in the map, causing
    the server to try to download them from HuggingFace.

    Since our servers are single-model instances, we unconditionally redirect
    every load call to the default model.
    """
    if model_path not in self.default_model_map and self.model is not None:
        # Already loaded — just return what we have
        return self.model, self.tokenizer
    return _orig_model_provider_load(self, model_path, adapter_path, draft_model_path)


_server.ModelProvider.load = _force_default_load
print("[wrapper] ModelProvider.load patched — all model IDs resolve to default")

# ---------------------------------------------------------------------------
# 4. Patch _serve_single to inject KV cache quantization kwargs
# ---------------------------------------------------------------------------

_OrigResponseGenerator = _server.ResponseGenerator


def _patched_serve_single(self, request):
    """Wraps _serve_single to inject kv_bits/kv_group_size/quantized_kv_start."""
    import mlx.core as mx
    from mlx_lm.models.cache import make_prompt_cache

    rqueue, req, args = request

    def progress(tokens_processed, tokens_total):
        rqueue.put((tokens_processed, tokens_total))

    try:
        model = self.model_provider.model
        tokenizer = self.model_provider.tokenizer
        draft_model = self.model_provider.draft_model

        prompt = self._tokenize(tokenizer, req, args)

        ctx = _server.GenerationContext(
            has_tool_calling=tokenizer.has_tool_calling,
            tool_call_start=tokenizer.tool_call_start,
            tool_call_end=tokenizer.tool_call_end,
            tool_parser=tokenizer.tool_parser,
            has_thinking=tokenizer.has_thinking,
            think_start_id=tokenizer.think_start_id,
            think_end=tokenizer.think_end,
            think_end_id=tokenizer.think_end_id,
            eos_token_ids=tokenizer.eos_token_ids,
            stop_token_sequences=[
                tokenizer.encode(stop_word, add_special_tokens=False)
                for stop_word in args.stop_words
            ],
            prompt=prompt,
        )
        rqueue.put(ctx)

        if args.seed is not None:
            mx.random.seed(args.seed)

        sampler = _server._make_sampler(args, tokenizer)
        logits_processors = _server._make_logits_processors(args)

        cache, rest = self.prompt_cache.fetch_nearest_cache(
            self.model_provider.model_key, prompt
        )
        cache_key = prompt[:]
        if cache is None:
            cache = make_prompt_cache(self.model_provider.model)
            if self.model_provider.draft_model is not None:
                cache += make_prompt_cache(self.model_provider.draft_model)

        # >>> KV cache quantization kwargs injected here <<<
        for gen in stream_generate(
            model=model,
            tokenizer=tokenizer,
            prompt=rest,
            max_tokens=args.max_tokens,
            sampler=sampler,
            logits_processors=logits_processors,
            prompt_cache=cache,
            draft_model=draft_model,
            num_draft_tokens=args.num_draft_tokens,
            prompt_progress_callback=progress,
            kv_bits=_kv_bits,
            kv_group_size=_kv_group_size,
            quantized_kv_start=_quantized_kv_start,
        ):
            rqueue.put(
                _server.Response(
                    gen.text,
                    gen.token,
                    gen.logprobs[gen.token].item(),
                    gen.finish_reason,
                    _server._format_top_logprobs(
                        gen.logprobs, args.top_logprobs, tokenizer
                    ),
                )
            )
            cache_key.append(gen.token)

            if ctx._should_stop:
                if self._is_distributed:
                    raise NotImplementedError()
                break

        rqueue.put(None)

        self.prompt_cache.insert_cache(self.model_provider.model_key, cache_key, cache)

    except Exception as e:
        rqueue.put(e)


if _kv_bits is not None:
    _server.ResponseGenerator._serve_single = _patched_serve_single

# ---------------------------------------------------------------------------
# 5. Run the server
# ---------------------------------------------------------------------------
_server.main()
