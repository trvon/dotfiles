# Pi Harness Dotfiles

Source of truth for this Pi setup: `~/Documents/depend/dotfiles/pi`.

## What is tracked

- `settings.json` (global behavior, model picker, package list)
- `models.json` (LM Studio provider + model registry)
- `health-watchdog-cron.example.json` (cron prompt template)
- `extensions/*.ts` and `extensions/*.md`
- `tests/smoke.mjs` (extension smoke checks)

Not tracked on purpose:

- `~/.pi/agent/auth.json`
- `~/.pi/agent/sessions/`
- local trace/runtime artifacts (`*.jsonl`, caches, binaries)

## Quick sync (dotfiles -> live Pi)

```bash
mkdir -p ~/.pi/agent/extensions && \
cp ~/Documents/depend/dotfiles/pi/settings.json ~/.pi/agent/settings.json && \
cp ~/Documents/depend/dotfiles/pi/models.json ~/.pi/agent/models.json && \
cp ~/Documents/depend/dotfiles/pi/health-watchdog-cron.example.json ~/.pi/agent/health-watchdog-cron.example.json && \
cp ~/Documents/depend/dotfiles/pi/extensions/*.ts ~/.pi/agent/extensions/ && \
cp ~/Documents/depend/dotfiles/pi/extensions/*.md ~/.pi/agent/extensions/
```

Then inside Pi run:

```text
/reload
```

Optional cron activation:

```bash
cp ~/.pi/agent/health-watchdog-cron.example.json ~/.pi/agent/health-watchdog-cron.json
```

## Current defaults

- `defaultThinkingLevel` is `high` in `settings.json`.
- Primary `unsloth/qwen3.5-35b-a3b` is configured at `262144` context in `models.json`.
- Models in `models.json` now set `maxTokens` up to each model's `contextWindow` to minimize `stopReason=length` truncation during long tool-planning turns.
- Package dependency is pinned: `npm:@sage-protocol/pi-adapter@0.1.5` in `settings.json`.

## Recommended env baseline

```bash
export PI_PRIMARY_MODEL=unsloth/qwen3.5-35b-a3b

export PI_OPTIMIZER_PROVIDER=lmstudio
export PI_OPTIMIZER_MODEL="$PI_PRIMARY_MODEL"
export PI_OPTIMIZER_RESEARCH_MODEL="$PI_PRIMARY_MODEL"
export PI_ORACLE_MODEL="$PI_PRIMARY_MODEL"
export PI_ORACLE_TIMEOUT_MS=12000

export PI_HYBRID_YAMS_ENABLED=1
export PI_HYBRID_YAMS_TIMEOUT_MS=12000
export PI_HYBRID_ALLOW_LOOSE_PARSE=0
export PI_HYBRID_FORWARD_OPTIMIZED_MESSAGE=1
export PI_HYBRID_FORWARD_PROMPT_MAX_CHARS=1200
export PI_HYBRID_SHOW_PROMPT_PAIR=1
export PI_HYBRID_PROMPT_PREVIEW_CHARS=700
export PI_HYBRID_COMPACTION_RATIO=0.93
export PI_HYBRID_COMPACTION_SAFETY_HEADROOM=16384

export PI_HEALTH_WATCHDOG_MODEL_STALL_MS=1200000
export PI_HEALTH_WATCHDOG_MODEL_SILENT_MS=20000
export PI_HEALTH_WATCHDOG_VERIFIER_MODEL="$PI_PRIMARY_MODEL"
export PI_HEALTH_WATCHDOG_VERIFIER_TIMEOUT_MS=20000
export PI_HEALTH_WATCHDOG_RECOVER_ON_TERMINATION=1
export PI_HEALTH_WATCHDOG_TERMINATION_MODE=balanced
export PI_HEALTH_WATCHDOG_TERMINATION_MIN_COMPLETE_CHARS=900
export PI_HEALTH_WATCHDOG_TERMINATION_VERIFY_AMBIGUOUS=1
export PI_HEALTH_WATCHDOG_TERMINATION_REQUIRE_ERROR_STOP=1
export PI_HEALTH_WATCHDOG_TERMINATION_COOLDOWN_MS=10000
export PI_HEALTH_WATCHDOG_WRITE_SCHEMA_WINDOW_MS=20000
export PI_HEALTH_WATCHDOG_WRITE_SCHEMA_MAX_ERRORS=2
export PI_HEALTH_WATCHDOG_WRITE_SCHEMA_GUARD_COOLDOWN_MS=45000
export PI_HEALTH_WATCHDOG_FINAL_TAIL_GRACE_MS=15000

export PI_RESEARCH_DCS_ROOT=/Users/trevon/work/tools/yams/external/agent
export PI_RESEARCH_FRAMEWORK_CLI=research-agent
export PI_RESEARCH_CRITIC_MODEL="$PI_PRIMARY_MODEL"

export PI_RUNTIME_TRACE_FILE=~/.pi/agent/runtime-trace.jsonl
export PI_HYBRID_TRACE_FILE=~/.pi/agent/hybrid-optimizer.jsonl
export PI_HEALTH_WATCHDOG_TRACE_FILE=~/.pi/agent/health-watchdog.jsonl
export PI_RESEARCH_TRACE_FILE=~/.pi/agent/research-orchestrator.jsonl
export PI_COMPACTION_GUARD_TRACE_FILE=~/.pi/agent/compaction-guard.jsonl
export PI_DOCTOR_SIGNAL_WINDOW_MS=900000
```

## Ops profiles

Stable:

```bash
export PI_HYBRID_COMPACTION_RATIO=0.93
export PI_HYBRID_COMPACTION_SAFETY_HEADROOM=16384
export PI_HEALTH_WATCHDOG_MAX_RETRIES=2
export PI_HEALTH_WATCHDOG_MODEL_STALL_MS=1200000
export PI_HEALTH_WATCHDOG_VERIFIER_TIMEOUT_MS=20000
export PI_ORACLE_TIMEOUT_MS=12000
export PI_HYBRID_YAMS_TIMEOUT_MS=12000
```

Aggressive:

```bash
export PI_HYBRID_COMPACTION_RATIO=0.95
export PI_HYBRID_COMPACTION_SAFETY_HEADROOM=12288
export PI_HEALTH_WATCHDOG_MAX_RETRIES=1
export PI_HEALTH_WATCHDOG_MODEL_STALL_MS=600000
export PI_HEALTH_WATCHDOG_VERIFIER_TIMEOUT_MS=12000
export PI_ORACLE_TIMEOUT_MS=10000
export PI_HYBRID_YAMS_TIMEOUT_MS=10000
```

## Useful commands

- Hybrid: `/hybrid`, `/hybrid-last`, `/hybrid-audit`, `/hybrid-proof-forward`, `/hybrid-hints`, `/hybrid-reset`, `/hybrid-proof`, `/hybrid-proof-research`, `/oracle-proof`
- Watchdog: `/watchdog-proof`, `/watchdog-proof-gate`, `/watchdog-proof-termination`, `/watchdog-proof-termination-complete`, `/watchdog-proof-termination-ambiguous`, `/watchdog-proof-termination-post-complete`, `/watchdog-proof-termination-duplicate`, `/watchdog-proof-termination-user-override`, `/watchdog-proof-write-schema-loop`, `/watchdog-proof-final-tail`
- Research: `/research-status`, `/research-framework-status`, `/research-gather <topic>`, `/research-critic`, `/research-pack`, `/research-review <topic>`
- Runtime trace: `/trace [status|clear|mark <label>]`, `/doctor` (legacy: `/trace-status`, `/trace-clear`, `/trace-mark <label>`)
- Compaction guard: `/compaction-guard-status`

## Active state indicators

- Footer chips should show these when extensions are active: `hybrid-opt`, `watchdog`, `research`, `runtime-trace`, `compaction-guard`.
- If a configured model is missing, `hybrid`, `watchdog`, and `research` now emit startup warnings instead of failing silently.

## Smoke tests

```bash
node ~/Documents/depend/dotfiles/pi/tests/smoke.mjs
```

Smoke tests verify:

- optimizer attempts/model calls + expected model IDs
- strict JSON optimizer gate by default (loose parse disabled unless explicitly enabled)
- optimized prompt forwarding event emission (`optimizer_forwarded_prompt`)
- watchdog verifier model usage
- verifier in-flight retry suppression
- balanced termination decisions (`termination_decision`), post-complete suppression, duplicate-signature suppression, and user-override suppression
- repeated invalid `write` tool-call loop suppression (`write_schema_guard_triggered`)
- final-tail grace suppression before recovery (`termination_recovery_suppressed` with `final_tail_pending`)
- research status event emission

## Reliability notes

- Hybrid guidance biases away from fragile `timeout 5s` shell/search calls for heavy scans.
- Watchdog uses balanced termination recovery by default: suppress complete outputs, retry likely-incomplete outputs, and verifier-gate ambiguous outputs.
- Watchdog now guards repeated invalid `write` tool calls and injects corrective continuation prompts to stop empty-arg tool-call loops.
- `/doctor` emphasizes recent signal windows; use `/trace clear` when starting a fresh debugging cycle.
- For full process crash recovery, run Pi under a supervisor (`launchd`, `systemd`, or `pm2`).
