# Health Watchdog Extension

This extension adds two behaviors to Pi:

1. **Stall recovery**: if a run stops making progress for too long, it aborts and retriggers with a bounded retry count.
2. **Cron-like prompts**: interval-based prompts from a local JSON file.

## Installed path

- Extension: `~/.pi/agent/extensions/health-watchdog.ts`
- Example cron config: `~/.pi/agent/health-watchdog-cron.example.json`

Pi auto-discovers extensions from `~/.pi/agent/extensions/`.

## Enable

1. Restart Pi, or run `/reload` in an active Pi session.
2. (Optional) copy the example cron config:

```bash
cp ~/.pi/agent/health-watchdog-cron.example.json ~/.pi/agent/health-watchdog-cron.json
```

Verifier probe command:

- `/watchdog-proof` runs a one-shot verifier check and reports whether it suggests `wait` or `retry`.
- `/watchdog-proof-gate` confirms retries are suppressed while verifier work is already in flight.
- `/watchdog-proof-termination` probes termination-triggered recovery.
- `/watchdog-proof-termination-complete` probes suppression when output appears complete.
- `/watchdog-proof-termination-ambiguous` probes verifier-gated behavior for ambiguous output.
- `/watchdog-proof-termination-post-complete` probes suppression when a short termination follows a substantive answer.
- `/watchdog-proof-termination-duplicate` probes duplicate-signature suppression.
- `/watchdog-proof-termination-user-override` probes suppression when a newer user prompt exists.
- `/watchdog-proof-write-schema-loop` probes repeated invalid `write` tool-call suppression.
- `/watchdog-proof-final-tail` probes suppression while final-tail grace window is active.

## Env knobs

- `PI_HEALTH_WATCHDOG_CHECK_MS` (default `5000`)
- `PI_HEALTH_WATCHDOG_TOOL_STALL_MS` (default `300000`)
- `PI_HEALTH_WATCHDOG_MODEL_STALL_MS` (default `1200000`)
- `PI_HEALTH_WATCHDOG_MODEL_SILENT_MS` (default `20000`)
- `PI_HEALTH_WATCHDOG_MODEL_NO_ASSISTANT_EXTRA_MS` (default `300000`)
- `PI_HEALTH_WATCHDOG_MODEL_EXTRA_PER_1K_TOKENS_MS` (default `1500`)
- `PI_HEALTH_WATCHDOG_MODEL_EXTRA_MAX_MS` (default `900000`)
- `PI_HEALTH_WATCHDOG_MAX_RETRIES` (default `2`)
- `PI_HEALTH_WATCHDOG_RETRY_COOLDOWN_MS` (default `30000`)
- `PI_HEALTH_WATCHDOG_NOTIFY` (`1`/`0`, default `1`)
- `PI_HEALTH_WATCHDOG_CRON_FILE` (default `~/.pi/agent/health-watchdog-cron.json`)
- `PI_HEALTH_WATCHDOG_VERIFY_BEFORE_RETRY` (`1`/`0`, default `1`)
- `PI_PRIMARY_MODEL` (default `unsloth/qwen3.5-35b-a3b`; shared fallback default)
- `PI_HEALTH_WATCHDOG_VERIFIER_PROVIDER` (default `lmstudio`)
- `PI_HEALTH_WATCHDOG_VERIFIER_MODEL` (default `PI_PRIMARY_MODEL`)
- `PI_HEALTH_WATCHDOG_VERIFIER_MAX_TOKENS` (default `120`)
- `PI_HEALTH_WATCHDOG_VERIFIER_TIMEOUT_MS` (default `20000`)
- `PI_HEALTH_WATCHDOG_RECOVER_ON_TERMINATION` (`1`/`0`, default `1`)
- `PI_HEALTH_WATCHDOG_TERMINATION_MODE` (`balanced`/`aggressive`, default `balanced`)
- `PI_HEALTH_WATCHDOG_TERMINATION_MIN_COMPLETE_CHARS` (default `900`)
- `PI_HEALTH_WATCHDOG_TERMINATION_VERIFY_AMBIGUOUS` (`1`/`0`, default `1`)
- `PI_HEALTH_WATCHDOG_TERMINATION_REQUIRE_ERROR_STOP` (`1`/`0`, default `1`)
- `PI_HEALTH_WATCHDOG_TERMINATION_COOLDOWN_MS` (default `10000`)
- `PI_HEALTH_WATCHDOG_WRITE_SCHEMA_WINDOW_MS` (default `20000`)
- `PI_HEALTH_WATCHDOG_WRITE_SCHEMA_MAX_ERRORS` (default `2`)
- `PI_HEALTH_WATCHDOG_WRITE_SCHEMA_GUARD_COOLDOWN_MS` (default `45000`)
- `PI_HEALTH_WATCHDOG_FINAL_TAIL_GRACE_MS` (default `15000`)
- `PI_HEALTH_WATCHDOG_UI_PROGRESS_NOTIFY_MS` (default `1500`)
- `PI_HEALTH_WATCHDOG_TRACE_FILE` (default `~/.pi/agent/health-watchdog.jsonl`)

Legacy compatibility: `PI_HEALTH_WATCHDOG_STALL_MS` is still accepted and maps to tool stall timeout.

## Cron file format

```json
{
  "jobs": [
    {
      "name": "Workspace check",
      "every": "30m",
      "prompt": "Review current status and suggest next actions.",
      "enabled": true,
      "deliverWhenBusy": false,
      "deliverMode": "followUp"
    }
  ]
}
```

Notes:

- `every` supports `ms`, `s`, `m`, `h` (for example `5000ms`, `30m`, `2h`).
- You can also use `everyMs` directly.
- If `deliverWhenBusy` is `false`, missed ticks are skipped while the agent is busy.

## Important limitation

This extension runs inside Pi. If the Pi process crashes, the extension cannot restart it by itself. For true dead-process recovery, run Pi under a supervisor (for example `launchd`, `systemd`, or `pm2`) and auto-restart the process.

The verifier step is advisory and conservative (it prefers `wait` over `retry` when uncertain) to reduce false cutoffs during long prompt processing.

If verifier calls fail/timeout, watchdog now prefers waiting over forced retry to avoid truncating the last assistant message.

Retries are also suppressed while a verifier check is still in flight, preventing overlapping verifier/retrigger loops.

If the assistant message ends with termination-like signals (for example `Error: terminated`, `operation aborted`, or abnormal stop reasons), watchdog records a termination candidate and applies balanced recovery logic by default:

- suppress retry for likely complete outputs,
- retry likely incomplete outputs,
- run verifier on ambiguous outputs (if enabled),
- suppress duplicate retries for the same termination signature,
- suppress auto-retry when a newer user prompt has already arrived.

When repeated invalid `write` tool calls are detected (missing `path`/`content` schema), watchdog emits a corrective continuation prompt to break malformed tool-call loops.

Balanced termination logic also treats short termination tails after a recently closed substantive assistant response as complete (`prior_complete_output`) to reduce last-message cutoffs.

When assistant `toolUse` chains are in flight, watchdog uses a final-tail grace window and defers retry/guard prompts until either a final assistant `stop` arrives or the grace window expires.

When verifier checks run, the extension now sets a live footer status and working message, and emits a visible "running" notice if checks take longer than the configured UI threshold.
