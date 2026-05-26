# Runtime Trace Extension

Captures Pi lifecycle and tool failure telemetry to help diagnose abrupt `Error: terminated` failures.

Installed file:

- `~/.pi/agent/extensions/runtime-trace.ts`

## What it traces

- session/agent/turn/message lifecycle events
- tool start/end with error payloads
- explicit termination-like signals (`terminated`, `aborted`, `cancel`)

On session start, this extension also sets a footer status chip (`runtime-trace`) so you can see it is active.

## Commands

- `/trace [status|clear|mark <label>]` - unified trace control for custom extension traces.
- `/doctor` - unified diagnostics (model/context mismatch, recent failures, trace sizes).
- `/trace-status` - show trace path and file size.
- `/trace-clear` - clear trace file.
- `/trace-mark <label>` - write manual marker for correlation.

## Environment knobs

- `PI_RUNTIME_TRACE_ENABLED` (`1`/`0`, default `1`)
- `PI_RUNTIME_TRACE_FILE` (default `~/.pi/agent/runtime-trace.jsonl`)
- `PI_RUNTIME_TRACE_MAX_TEXT` (default `320`)
- `PI_DOCTOR_SIGNAL_WINDOW_MS` (default `900000`, 15 minutes)
- `PI_LMSTUDIO_MODELS_URL` (default `http://localhost:1234/api/v0/models`)
- `PI_LMSTUDIO_MODELS_TIMEOUT_MS` (default `2500`)

## Suggested workflow for termination debugging

1. Run `/trace-clear`.
2. Reproduce the failing flow.
3. Run `/trace-mark reproduced-terminated`.
4. Inspect `~/.pi/agent/runtime-trace.jsonl` and correlate with:
   - `~/.pi/agent/health-watchdog.jsonl`
   - `~/.pi/agent/hybrid-optimizer.jsonl`
   - `~/.pi/agent/research-orchestrator.jsonl`

This gives a timestamped chain from tool start to termination detection.
