#!/usr/bin/env bash
# Start mlx_lm server for Gemma 4 on M4 Max 128GB
# Usage: ./start-gemma4-mlx.sh [port] [model]
#
# Tuned to minimize time-to-first-token (TTFT) and maximize generation speed.
# llama-server equivalents noted in comments.
set -euo pipefail

PORT="${1:-8081}"
MODEL="${2:-mlx-community/gemma-4-26b-a4b-it-4bit}"

exec mlx_lm.server \
  --model "$MODEL" \
  --host 127.0.0.1 \
  --port "$PORT" \
  --trust-remote-code \
  --chat-template-args '{"enable_thinking":false}' \
  --max-tokens 4096 \
  --prefill-step-size 4096 \
  --prompt-cache-size 20 \
  --prompt-concurrency 2 \
  --decode-concurrency 32 \
  --log-level INFO
