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
- `PI_HEALTH_WATCHDOG_VERIFIER_PROVIDER` (default `lmstudio`)
- `PI_HEALTH_WATCHDOG_VERIFIER_MODEL` (default `mistralai/ministral-3-14b-reasoning`)
- `PI_HEALTH_WATCHDOG_VERIFIER_MAX_TOKENS` (default `120`)
- `PI_HEALTH_WATCHDOG_VERIFIER_TIMEOUT_MS` (default `5000`)
- `PI_HEALTH_WATCHDOG_UI_PROGRESS_NOTIFY_MS` (default `1500`)
- `PI_HEALTH_WATCHDOG_TRACE_FILE` (default empty; when set, writes JSONL trace events)

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

When verifier checks run, the extension now sets a live footer status and working message, and emits a visible "running" notice if checks take longer than the configured UI threshold.
