# Hybrid Optimizer Extension

This extension blends low-latency and high-quality behavior for local models.

Installed file:

- `~/.pi/agent/extensions/hybrid-optimizer.ts`

## What it does

1. Uses optimizer models with profile routing: default optimizer is `unsloth/qwen3.5-27b` (research and general), with fallbacks if unavailable.
2. Stores optimizer state with `appendEntry` so it survives restarts without bloating LLM context.
3. Injects a short per-turn execution brief via `before_agent_start`.
4. Deduplicates repeated Sage skill/tool boilerplate in the `context` hook.
5. Pulls relevant memory hints from YAMS (`yams search --cwd`) and injects only compact snippets.
6. Triggers compaction proactively only at high usage with cooldown and minimum token guards.
7. Shows live UI status while optimizer model calls are running.

## Commands

- `/hybrid` - show current optimizer mode/status.
- `/hybrid-reset` - clear carry-state memory.
- `/hybrid-hints` - show currently loaded YAMS hints.
- `/hybrid-proof` - run one-shot optimizer probe against `PI_OPTIMIZER_MODEL` (fallback `mistralai/ministral-3-14b-reasoning`).
- `/hybrid-proof-research` - probe research optimizer routing/model.

## Environment knobs

- `PI_OPTIMIZER_PROVIDER` (default `lmstudio`)
- `PI_OPTIMIZER_MODEL` (default `unsloth/qwen3.5-27b`)
- `PI_OPTIMIZER_RESEARCH_MODEL` (default `unsloth/qwen3.5-27b`)
- `PI_OPTIMIZER_MIN_CHARS` (default `120`)
- `PI_OPTIMIZER_MAX_TOKENS` (default `700`)
- `PI_HYBRID_UI_PROGRESS_NOTIFY_MS` (default `1500`)
- `PI_HYBRID_AUTO_THINKING` (`1`/`0`, default `1`)
- `PI_HYBRID_YAMS_ENABLED` (`1`/`0`, default `1`)
- `PI_HYBRID_PROFILE_EMBED_ROUTER` (`1`/`0`, default `1`)
- `PI_HYBRID_YAMS_LIMIT` (default `4`)
- `PI_HYBRID_YAMS_TIMEOUT_MS` (default `4500`)
- `PI_HYBRID_COMPACTION_RATIO` (0-1, default `0.82`)
- `PI_HYBRID_COMPACTION_MIN_TOKENS` (default `180000`)
- `PI_HYBRID_COMPACTION_COOLDOWN_MS` (default `180000`)
- `PI_HYBRID_KEEP_RECENT_ASSISTANT` (default `6`)
- `PI_HYBRID_CAP_OLD_ASSISTANT_TEXT` (default `1800`)
- `PI_HYBRID_TRACE_FILE` (default empty; when set, writes JSONL trace events)

## Notes

- If optimizer model is not available, the extension falls back to heuristic fast/deep mode.
- If prompt looks like raw tool logs/terminated payloads, optimizer is bypassed to avoid over-optimization loops.
- Context pruning keeps the latest tooling block and latest block per skill to avoid stale tool catalogs during long sessions.
- If YAMS is unavailable, the extension continues without external memory hints.
- This extension is designed to work with the existing watchdog extension.
- Reload Pi (`/reload`) after changes.
