# Runtime Trace Extension

Captures Pi lifecycle and tool failure telemetry to help diagnose abrupt `Error: terminated` failures.

Installed file:

- `~/.pi/agent/extensions/runtime-trace.ts`

## What it traces

- session/agent/turn/message lifecycle events
- tool start/end with error payloads
- explicit termination-like signals (`terminated`, `aborted`, `cancel`)

## Commands

- `/trace-status` - show trace path and file size.
- `/trace-clear` - clear trace file.
- `/trace-mark <label>` - write manual marker for correlation.

## Environment knobs

- `PI_RUNTIME_TRACE_ENABLED` (`1`/`0`, default `1`)
- `PI_RUNTIME_TRACE_FILE` (default `~/.pi/agent/runtime-trace.jsonl`)
- `PI_RUNTIME_TRACE_MAX_TEXT` (default `320`)

## Suggested workflow for termination debugging

1. Run `/trace-clear`.
2. Reproduce the failing flow.
3. Run `/trace-mark reproduced-terminated`.
4. Inspect `~/.pi/agent/runtime-trace.jsonl` and correlate with:
   - `~/.pi/agent/extensions/health-watchdog` trace file (if enabled)
   - `~/.pi/agent/extensions/hybrid-optimizer` trace file (if enabled)

This gives a timestamped chain from tool start to termination detection.
