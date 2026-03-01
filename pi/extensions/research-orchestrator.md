# Research Orchestrator Extension

Adds a research-focused workflow on top of Pi + Research Framework agent (DCS) + YAMS for literature reviews.

Installed file:

- `~/.pi/agent/extensions/research-orchestrator.ts`

## What it does

1. Wraps framework CLI (`uv run --project ... research-agent`, fallback `dcs`) as a gather stage for retrieval-grounded notes.
2. Runs a critic pass using a configurable local model to detect gaps and weak evidence.
3. Stores gather/critic state in session custom entries.
4. Surfaces DCS executor/critic model IDs used during gather runs.
5. Can queue a final synthesis packet back into the active Pi conversation.

## Commands

- `/research-status` - check YAMS + framework connectivity.
- `/research-framework-status` - alias for `/research-status`.
- `/research-gather <topic>` - run gather pass via DCS.
- `/research-critic [text]` - critique latest gather output (or provided text).
- `/research-pack` - show current gather + critic packet.
- `/research-review <topic>` - run gather + critic and queue final synthesis turn.

## Environment knobs

- `PI_RESEARCH_DCS_ROOT` (default `/Users/trevon/work/tools/yams/external/agent`)
- `PI_RESEARCH_FRAMEWORK_CLI` (default `research-agent`; fallback `dcs`)
- `PI_RESEARCH_DCS_TIMEOUT_MS` (default `900000`)
- `PI_RESEARCH_DCS_CONTEXT_PROFILE` (default `large`)
- `PI_PRIMARY_MODEL` (default `unsloth/qwen3.5-35b-a3b`; shared fallback default)
- `PI_RESEARCH_CRITIC_PROVIDER` (default `lmstudio`)
- `PI_RESEARCH_CRITIC_MODEL` (default `PI_PRIMARY_MODEL`)
- `PI_RESEARCH_CRITIC_MAX_TOKENS` (default `900`)
- `PI_RESEARCH_TRACE_FILE` (default `~/.pi/agent/research-orchestrator.jsonl`)

## Notes

- Gather stage requires `uv`, framework project dependencies, YAMS daemon, and LM Studio endpoint.
- Critic stage falls back to heuristic output if model call/parsing fails.
- Reload Pi (`/reload`) after installing/updating extension.
