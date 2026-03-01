# Hybrid Optimizer Extension

This extension blends low-latency and high-quality behavior for local models.

Installed file:

- `~/.pi/agent/extensions/hybrid-optimizer.ts`

## What it does

1. Uses optimizer models with profile routing: default optimizer is `unsloth/qwen3.5-35b-a3b` (research and general), with fallbacks if unavailable.
2. Stores optimizer state with `appendEntry` so it survives restarts without bloating LLM context.
3. Injects a short per-turn execution brief via `before_agent_start`.
4. Deduplicates repeated Sage skill/tool boilerplate in the `context` hook.
5. Pulls relevant memory hints from YAMS (`yams search --cwd`) and injects only compact snippets.
6. Triggers compaction proactively only at high usage with cooldown and minimum token guards.
7. Shows live UI status while optimizer model calls are running.
8. Runs an oracle validator pass on deep/risky prompts and injects required checks.
9. Captures and shows the last original/optimized prompt pair in UI notifications and via command.
10. Applies strict JSON parsing by default (loose parse disabled) to prevent malformed optimizer payloads from steering the main turn.
11. Injects a hidden forwarded prompt message so the optimized prompt is explicitly delivered to the main agent turn.

## Commands

- `/hybrid` - show current optimizer mode/status.
- `/hybrid-last` - show last original + optimized prompt pair.
- `/hybrid-audit` - show optimizer flow guardrails (loose parse/message forwarding).
- `/hybrid-proof-forward` - probe forwarded optimized prompt formatting/tracing.
- `/hybrid-reset` - clear carry-state memory.
- `/hybrid-hints` - show currently loaded YAMS hints.
- `/hybrid-proof` - run one-shot optimizer probe against `PI_OPTIMIZER_MODEL` (fallback `mistralai/ministral-3-14b-reasoning`).
- `/hybrid-proof-research` - probe research optimizer routing/model.
- `/oracle-proof` - probe oracle validator model and parser.

## Environment knobs

- `PI_OPTIMIZER_PROVIDER` (default `lmstudio`)
- `PI_PRIMARY_MODEL` (default `unsloth/qwen3.5-35b-a3b`; shared default used when optimizer/oracle model envs are unset)
- `PI_OPTIMIZER_MODEL` (default `unsloth/qwen3.5-35b-a3b`)
- `PI_OPTIMIZER_RESEARCH_MODEL` (default `unsloth/qwen3.5-35b-a3b`)
- `PI_ORACLE_ENABLED` (`1`/`0`, default `1`)
- `PI_ORACLE_PROVIDER` (default `lmstudio`)
- `PI_ORACLE_MODEL` (default `PI_PRIMARY_MODEL`)
- `PI_ORACLE_MAX_TOKENS` (default `160`)
- `PI_ORACLE_TIMEOUT_MS` (default `12000`)
- `PI_OPTIMIZER_MIN_CHARS` (default `120`)
- `PI_OPTIMIZER_MAX_TOKENS` (default `700`)
- `PI_HYBRID_UI_PROGRESS_NOTIFY_MS` (default `1500`)
- `PI_HYBRID_AUTO_THINKING` (`1`/`0`, default `1`)
- `PI_HYBRID_YAMS_ENABLED` (`1`/`0`, default `1`)
- `PI_HYBRID_PROFILE_EMBED_ROUTER` (`1`/`0`, default `1`)
- `PI_HYBRID_YAMS_LIMIT` (default `4`)
- `PI_HYBRID_YAMS_TIMEOUT_MS` (default `12000`)
- `PI_LMSTUDIO_MODELS_URL` (default `http://localhost:1234/api/v0/models`)
- `PI_LMSTUDIO_MODELS_TIMEOUT_MS` (default `2500`)
- `PI_HYBRID_ALLOW_LOOSE_PARSE` (`1`/`0`, default `0`)
- `PI_HYBRID_FORWARD_OPTIMIZED_MESSAGE` (`1`/`0`, default `1`)
- `PI_HYBRID_FORWARD_PROMPT_MAX_CHARS` (default `1200`)
- `PI_HYBRID_SHOW_PROMPT_PAIR` (`1`/`0`, default `1`)
- `PI_HYBRID_PROMPT_PREVIEW_CHARS` (default `700`)
- `PI_HYBRID_PROMPT_STATE_CHARS` (default `2400`)
- `PI_HYBRID_COMPACTION_RATIO` (0-1, default `0.93`)
- `PI_HYBRID_COMPACTION_MIN_TOKENS` (default `180000`)
- `PI_HYBRID_COMPACTION_COOLDOWN_MS` (default `180000`)
- `PI_HYBRID_COMPACTION_SAFETY_HEADROOM` (default `16384`)
- `PI_HYBRID_KEEP_RECENT_ASSISTANT` (default `6`)
- `PI_HYBRID_CAP_OLD_ASSISTANT_TEXT` (default `1800`)
- `PI_HYBRID_TRACE_FILE` (default `~/.pi/agent/hybrid-optimizer.jsonl`)

## Notes

- If optimizer model is not available, the extension falls back to heuristic fast/deep mode.
- If prompt looks like raw tool logs/terminated payloads, optimizer is bypassed to avoid over-optimization loops.
- Context pruning keeps the latest tooling block and latest block per skill to avoid stale tool catalogs during long sessions.
- Compaction threshold uses LM Studio loaded context length when available, and warns when loaded context is below configured context.
- If YAMS is unavailable, the extension continues without external memory hints.
- This extension is designed to work with the existing watchdog extension.
- Reload Pi (`/reload`) after changes.
