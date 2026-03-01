# Compaction Guard Extension

Stabilizes compaction on smaller-context models and prevents pathological compaction loops.

Installed file:

- `~/.pi/agent/extensions/compaction-guard.ts`

## What it does

1. Intercepts `session_before_compact`.
2. Detects risky settings relative to active model context window.
3. Falls back to deterministic safe summary (no model call) when risk is high.
4. Emits JSONL trace events for diagnosis.
5. Sets a footer status chip (`compaction-guard`) on session start.

This prevents repeated compaction failures like:

- `The number of tokens to keep from the initial prompt is greater than the context length`

## Commands

- `/compaction-guard-status` - show active model and context window.

## Environment knobs

- `PI_COMPACTION_GUARD_TRACE_ENABLED` (`1`/`0`, default `1`)
- `PI_COMPACTION_GUARD_TRACE_FILE` (default `~/.pi/agent/compaction-guard.jsonl`)
- `PI_COMPACTION_GUARD_FORCE_SIMPLE_UNDER_TOKENS` (default `512`)

## Notes

- This extension does not disable regular compaction.
- It only swaps in a safe deterministic summary when settings/context are risky.
