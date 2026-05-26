# Pi Harness Dotfiles

Shared Pi harness config for local-model workflows.

This directory tracks:

- `settings.json` (global Pi behavior)
- `models.json` (provider/model registry)
- `health-watchdog-cron.example.json` (cron template)
- `extensions/health-watchdog.ts`
- `extensions/hybrid-optimizer.ts`
- `extensions/research-orchestrator.ts`
- `extensions/runtime-trace.ts`
- `extensions/compaction-guard.ts`

It intentionally does **not** track:

- `~/.pi/agent/auth.json` (secrets)
- `~/.pi/agent/sessions/` (local conversation history)
- `~/.pi/agent/bin/` (local binaries/cache)

## Prerequisites

- Pi CLI installed and working
- LM Studio local server running at `http://localhost:1234/v1`
- Models loaded in LM Studio that match `models.json`
- Optional: YAMS CLI if you want retrieval hints in `hybrid-optimizer`

## Install (copy from dotfiles -> live Pi)

```bash
mkdir -p ~/.pi/agent/extensions
cp ~/Documents/depend/dotfiles/pi/settings.json ~/.pi/agent/settings.json
cp ~/Documents/depend/dotfiles/pi/models.json ~/.pi/agent/models.json
cp ~/Documents/depend/dotfiles/pi/health-watchdog-cron.example.json ~/.pi/agent/health-watchdog-cron.example.json
cp ~/Documents/depend/dotfiles/pi/extensions/*.ts ~/.pi/agent/extensions/
cp ~/Documents/depend/dotfiles/pi/extensions/*.md ~/.pi/agent/extensions/
```

Then reload Pi:

```bash
# inside Pi
/reload
```

## Optional cron activation

```bash
cp ~/.pi/agent/health-watchdog-cron.example.json ~/.pi/agent/health-watchdog-cron.json
```

## Recommended env vars

Example shell profile settings:

```bash
export PI_OPTIMIZER_PROVIDER=lmstudio
export PI_OPTIMIZER_MODEL=unsloth/qwen3.5-27b
export PI_OPTIMIZER_RESEARCH_MODEL=unsloth/qwen3.5-27b
export PI_HYBRID_UI_PROGRESS_NOTIFY_MS=1500
export PI_HYBRID_YAMS_ENABLED=1
export PI_HYBRID_COMPACTION_RATIO=0.82
export PI_HEALTH_WATCHDOG_TOOL_STALL_MS=300000
export PI_HEALTH_WATCHDOG_MODEL_STALL_MS=1200000
export PI_HEALTH_WATCHDOG_MODEL_SILENT_MS=20000
export PI_HEALTH_WATCHDOG_UI_PROGRESS_NOTIFY_MS=1500
export PI_RESEARCH_DCS_ROOT=/Users/trevon/work/tools/yams/external/agent
export PI_RESEARCH_CRITIC_MODEL=mistralai/ministral-3-14b-reasoning
export PI_RUNTIME_TRACE_FILE=~/.pi/agent/runtime-trace.jsonl
export PI_COMPACTION_GUARD_TRACE_FILE=~/.pi/agent/compaction-guard.jsonl
```

## Day-to-day workflow

1. Edit files in this repo (`~/Documents/depend/dotfiles/pi`).
2. Copy updates into `~/.pi/agent`.
3. Run `/reload` in Pi.
4. Test commands:
   - `/hybrid`
   - `/hybrid-hints`
   - `/hybrid-reset`
   - `/hybrid-proof`
   - `/watchdog-proof`
   - `/research-status`
   - `/research-gather <topic>`
   - `/research-critic`
   - `/research-review <topic>`
   - `/trace-status`
   - `/trace-clear`
   - `/trace-mark <label>`
   - `/compaction-guard-status`

## Smoke tests

Run extension smoke tests (optimizer model + watchdog verifier + research stack check):

```bash
node ~/Documents/depend/dotfiles/pi/tests/smoke.mjs
```

The test writes temporary JSONL traces to `/tmp` and verifies that:

- hybrid optimizer records `optimizer_attempt` + `optimizer_model_call` (+ success/fallback)
- watchdog verifier records `verifier_attempt` + `verifier_decision` (or timeout error)
- research orchestrator records `status` after `/research-status`

## Sync helper (optional)

```bash
mkdir -p ~/.pi/agent/extensions && \
cp ~/Documents/depend/dotfiles/pi/settings.json ~/.pi/agent/settings.json && \
cp ~/Documents/depend/dotfiles/pi/models.json ~/.pi/agent/models.json && \
cp ~/Documents/depend/dotfiles/pi/health-watchdog-cron.example.json ~/.pi/agent/health-watchdog-cron.example.json && \
cp ~/Documents/depend/dotfiles/pi/extensions/*.ts ~/.pi/agent/extensions/ && \
cp ~/Documents/depend/dotfiles/pi/extensions/*.md ~/.pi/agent/extensions/
```

## Notes

- `settings.json` currently uses high default thinking.
- Qwen models are configured for `262144` context window in `models.json`.
- If Pi process recovery is needed after hard crashes, pair with an external supervisor (`launchd`, `systemd`, or `pm2`).
