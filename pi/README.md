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
- Compaction triggers at ~64k tokens (`COMPACTION_RATIO=0.25` * 262k). Tuned for M4 Max performance sweet spot.
- Context window sanity floor: if LM Studio reports `loaded_context_length < 10%` of configured, the configured value is used instead (catches the n_ctx=4096 bug).
- RLM retrieval uses `--similarity 0.001` to bypass YAMS's default 0.7 threshold; the `RLM_MIN_SCORE=0.003` filter applies after.
- RLM uses tiered retrieval: session-scoped memories first (tag `session:<id>`), then global cross-session memories (tag `rlm`) to fill remaining slots. Each stored chunk gets three tags: `rlm`, `pi-session-memory`, and `session:<rlmSessionId>`. Session IDs use the format `pi-<base36-timestamp>` (compact, sortable, unique per session).
- All LLM sidecar calls use inactivity-based timeouts instead of wall-clock timeouts. The timer resets on every streaming event; abort only fires when no events arrive within the threshold. 35b calls (oracle, research critic) use 45s; 9b calls (optimizer, watchdog verifier, RLM extractor, compaction summarizer) use 20s.

## Model routing

| Role | Model | Rationale |
|------|-------|-----------|
| Main chat | `unsloth/qwen3.5-35b-a3b` | Primary, high-accuracy |
| Optimizer | `qwen3.5-9b` | Sidecar, speed-optimized |
| Research optimizer | `qwen3.5-9b` | Sidecar, speed-optimized |
| Oracle | `unsloth/qwen3.5-35b-a3b` | Validation needs accuracy |
| Watchdog verifier | `qwen3.5-9b` | Sidecar, speed-optimized |
| RLM extractor | `qwen3.5-9b` | Sidecar, falls back to heuristic |
| Compaction summarizer | `qwen3.5-9b` | Sidecar, falls back to heuristic |
| DCS enrichment | `unsloth/qwen3.5-35b-a3b` | Via global `research-agent` CLI |

Set `PI_RLM_EXTRACTOR_MODE=heuristic` to disable model-based extraction and use the regex/pattern heuristic instead.
Set `PI_COMPACTION_MODEL` to route compaction summarization to a sidecar model instead of the main 35b model.
Set `PI_COMPACTION_DCS_ENABLED=1` to enable DCS multi-hop summarization for compaction (opt-in, high latency).
Set `PI_RLM_DCS_SESSION_ENRICHMENT=1` to enable DCS session-start context enrichment from RLM memories (opt-in).

## Recommended env baseline

```bash
export PI_PRIMARY_MODEL=unsloth/qwen3.5-35b-a3b

# Optimizer + research optimizer: routed to lighter 9b model for speed
export PI_OPTIMIZER_PROVIDER=lmstudio
export PI_OPTIMIZER_MODEL=qwen3.5-9b
export PI_OPTIMIZER_RESEARCH_MODEL=qwen3.5-9b

# Oracle: stays on primary 35b model for accuracy
export PI_ORACLE_MODEL="$PI_PRIMARY_MODEL"
export PI_ORACLE_INACTIVITY_MS=45000          # Inactivity timeout for 35b oracle call

export PI_HYBRID_YAMS_ENABLED=1
export PI_HYBRID_YAMS_TIMEOUT_MS=12000
export PI_HYBRID_ALLOW_LOOSE_PARSE=0
export PI_HYBRID_FORWARD_OPTIMIZED_MESSAGE=1
export PI_HYBRID_FORWARD_PROMPT_MAX_CHARS=1200
export PI_HYBRID_SHOW_PROMPT_PAIR=1
export PI_HYBRID_PROMPT_PREVIEW_CHARS=700
export PI_HYBRID_COMPACTION_RATIO=0.25
export PI_HYBRID_COMPACTION_MIN_TOKENS=54000
export PI_HYBRID_COMPACTION_SAFETY_HEADROOM=16384
export PI_OPTIMIZER_INACTIVITY_MS=20000        # Inactivity timeout for 9b optimizer call
# Uncomment to hard-override effective context window (bypasses LM Studio query):
# export PI_HYBRID_CONTEXT_WINDOW_OVERRIDE=75000

export PI_HEALTH_WATCHDOG_MODEL_STALL_MS=1200000
export PI_HEALTH_WATCHDOG_MODEL_SILENT_MS=20000
# Watchdog verifier: routed to lighter 9b model for speed
export PI_HEALTH_WATCHDOG_VERIFIER_MODEL=qwen3.5-9b
export PI_HEALTH_WATCHDOG_VERIFIER_INACTIVITY_MS=20000  # Inactivity timeout for 9b verifier
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

# RLM extractor: model-based extraction using 9b (falls back to heuristic on failure)
export PI_RLM_EXTRACTOR_MODE=model
export PI_RLM_EXTRACTOR_PROVIDER=lmstudio
export PI_RLM_EXTRACTOR_MODEL=qwen3.5-9b
export PI_RLM_EXTRACTOR_MAX_TOKENS=1200
export PI_RLM_EXTRACTOR_INACTIVITY_MS=20000    # Inactivity timeout for 9b RLM extractor
export PI_RLM_EXTRACTOR_MAX_INPUT_CHARS=12000
# RLM retrieval: lower similarity lets YAMS return more candidates; RLM_MIN_SCORE filters after
export PI_RLM_SEARCH_SIMILARITY=0.001

# Context flooding protection
export PI_TOOL_OUTPUT_MAX_CHARS=8000       # Max chars per tool result before head+tail truncation
export PI_TOOL_OUTPUT_HEAD_CHARS=7000      # Chars to keep from start of truncated tool output
export PI_TOOL_OUTPUT_TAIL_CHARS=500       # Chars to keep from end of truncated tool output
export PI_COMPACTION_TIMEOUT_MS=60000      # Max wait time for compaction before clearing flag
export PI_CONTEXT_BUDGET_WARN_TOKENS=200000 # Token count for critical YAMS-first budget warning
export PI_CONTEXT_BUDGET_STEER_TOKENS=80000 # Token count for YAMS-first steering when dir paths detected

# Compaction summarizer: routes summarization to 9b instead of main 35b model
# Falls back to heuristic summary if 9b fails/times out
export PI_COMPACTION_MODEL=qwen3.5-9b
export PI_COMPACTION_PROVIDER=lmstudio
export PI_COMPACTION_INACTIVITY_MS=30000       # Inactivity timeout for 9b summarization call (default raised from 20s to 30s for GPU contention at turn boundaries)
export PI_COMPACTION_MAX_INPUT_CHARS=24000     # Max chars of serialized conversation to send to 9b
export PI_COMPACTION_MAX_TOKENS=4096           # Max output tokens for 9b summary

# DCS integration for compaction: opt-in multi-hop summarization via research-agent CLI
# When enabled, compaction tries DCS first, then falls back to 9b, then heuristic
# export PI_COMPACTION_DCS_ENABLED=1           # Default: false (opt-in)
# export PI_COMPACTION_DCS_TIMEOUT_MS=120000   # Default: 120s
# export PI_COMPACTION_DCS_CLI=research-agent  # Default: research-agent (global install)
# export PI_COMPACTION_DCS_CONTEXT_PROFILE=small # Default: small

# DCS integration for RLM: session-start enrichment and on-demand deep recall
# When enrichment is enabled, first turn runs DCS multi-hop on retrieved RLM memories
# export PI_RLM_DCS_SESSION_ENRICHMENT=1       # Default: false (opt-in)
# export PI_RLM_DCS_SESSION_TIMEOUT_MS=60000   # Default: 60s
# export PI_RLM_DEEP_RECALL_TIMEOUT_MS=120000  # Default: 120s (for /rlm-deep-recall)
# export PI_RLM_DCS_CLI=research-agent         # Default: research-agent (global install)

export PI_RESEARCH_DCS_ROOT=/Users/trevon/work/tools/yams/external/agent
export PI_RESEARCH_FRAMEWORK_CLI=research-agent
export PI_RESEARCH_CRITIC_MODEL="$PI_PRIMARY_MODEL"
export PI_RESEARCH_CRITIC_INACTIVITY_MS=45000  # Inactivity timeout for 35b critic call

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
export PI_HYBRID_COMPACTION_RATIO=0.25
export PI_HYBRID_COMPACTION_MIN_TOKENS=54000
export PI_HYBRID_COMPACTION_SAFETY_HEADROOM=16384
export PI_HEALTH_WATCHDOG_MAX_RETRIES=2
export PI_HEALTH_WATCHDOG_MODEL_STALL_MS=1200000
export PI_HEALTH_WATCHDOG_VERIFIER_INACTIVITY_MS=20000
export PI_ORACLE_INACTIVITY_MS=45000
export PI_HYBRID_YAMS_TIMEOUT_MS=12000
```

Aggressive:

```bash
export PI_HYBRID_COMPACTION_RATIO=0.20
export PI_HYBRID_COMPACTION_MIN_TOKENS=40000
export PI_HYBRID_COMPACTION_SAFETY_HEADROOM=12288
export PI_HEALTH_WATCHDOG_MAX_RETRIES=1
export PI_HEALTH_WATCHDOG_MODEL_STALL_MS=600000
export PI_HEALTH_WATCHDOG_VERIFIER_INACTIVITY_MS=12000
export PI_ORACLE_INACTIVITY_MS=30000
export PI_HYBRID_YAMS_TIMEOUT_MS=10000
```

## Useful commands

- Hybrid: `/hybrid`, `/hybrid-last`, `/hybrid-audit`, `/hybrid-proof-forward`, `/hybrid-hints`, `/hybrid-reset`, `/hybrid-proof`, `/hybrid-proof-research`, `/oracle-proof`
- RLM: `/rlm`, `/rlm-deep-recall <topic>`
- Ultrawork harness: tool interface `ultrawork` (JSON actions: help, status, submit, dispatch, list_tasks, add_task, set_task, mode, reset) plus command wrappers `/ultrawork [objective]`, `/ultrawork-help`, `/task [list|add|start|done|cancel|reset]`
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

## DCS (Dynamic Context Scaffold) integration

DCS provides multi-hop retrieval and synthesis via the `research-agent` CLI (globally installed via `uv tool install`). Three integration points:

1. **Compaction summarization** (`compaction-guard.ts`): When `PI_COMPACTION_DCS_ENABLED=1`, compaction tries DCS -> 9b -> heuristic fallback chain. DCS gets the full conversation serialized as a task prompt and produces a richer summary than the 9b sidecar alone. High latency (~60-120s) but better accuracy for complex sessions.

2. **Session-start enrichment** (`hybrid-optimizer.ts`): When `PI_RLM_DCS_SESSION_ENRICHMENT=1`, the first turn of each session runs DCS multi-hop retrieval using previously retrieved RLM memories as seed context. The enriched briefing is injected once into the system prompt as a `[DCS Context Briefing]` section. Subsequent turns do not re-run enrichment.

3. **On-demand deep recall** (`/rlm-deep-recall <topic>`): User-triggered command that runs DCS with a `large` context profile for thorough multi-hop retrieval on any topic. Returns synthesized results covering relevant decisions, file paths, code patterns, and known issues.

DCS configuration lives in `~/work/tools/yams/external/agent/configs/models.yaml`. Default executor and critic both point to `unsloth/qwen3.5-35b-a3b` (262k context, 4096 max output, 300s timeout).

## Compaction branchEntries fallback

When Pi's `prepareCompaction()` produces an empty `messagesToSummarize` array (all messages fall in the "kept" window from Pi's perspective), but the total token count exceeds 1000, compaction-guard falls back to using ALL `event.branchEntries` for summarization input. This prevents the "9b unavailable, using heuristic summary" false notification that occurred when the 9b was never actually tried.

The `branchEntries` helper (`getMessagesFromBranchEntries()` in compaction-guard.ts) mirrors Pi's internal `getMessageFromEntry()` -- it converts `type: "message"`, `type: "custom_message"`, and `type: "branch_summary"` entries to `{ role, content }` format for the summarizer.

## Reliability notes

- Hybrid guidance biases away from fragile `timeout 5s` shell/search calls for heavy scans.
- Watchdog uses balanced termination recovery by default: suppress complete outputs, retry likely-incomplete outputs, and verifier-gate ambiguous outputs.
- Watchdog now guards repeated invalid `write` tool calls and injects corrective continuation prompts to stop empty-arg tool-call loops.
- `/doctor` emphasizes recent signal windows; use `/trace clear` when starting a fresh debugging cycle.
- For full process crash recovery, run Pi under a supervisor (`launchd`, `systemd`, or `pm2`).
