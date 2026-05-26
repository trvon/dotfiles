# Research Orchestrator Extension

Adds a research-focused workflow on top of Pi + DCS + YAMS for literature reviews.

Installed file:

- `~/.pi/agent/extensions/research-orchestrator.ts`

## What it does

1. Wraps DCS (`uv run --project ... dcs`) as a gather stage for retrieval-grounded notes.
2. Runs a critic pass using a configurable local model to detect gaps and weak evidence.
3. Stores gather/critic state in session custom entries.
4. Surfaces DCS executor/critic model IDs used during gather runs.
5. Can queue a final synthesis packet back into the active Pi conversation.

## Commands

- `/research-status` - check YAMS + DCS connectivity.
- `/research-gather <topic>` - run gather pass via DCS.
- `/research-critic [text]` - critique latest gather output (or provided text).
- `/research-pack` - show current gather + critic packet.
- `/research-review <topic>` - run gather + critic and queue final synthesis turn.

## Environment knobs

- `PI_RESEARCH_DCS_ROOT` (default `/Users/trevon/work/tools/yams/external/agent`)
- `PI_RESEARCH_DCS_TIMEOUT_MS` (default `900000`)
- `PI_RESEARCH_DCS_CONTEXT_PROFILE` (default `large`)
- `PI_RESEARCH_CRITIC_PROVIDER` (default `lmstudio`)
- `PI_RESEARCH_CRITIC_MODEL` (default `mistralai/ministral-3-14b-reasoning`)
- `PI_RESEARCH_CRITIC_MAX_TOKENS` (default `900`)
- `PI_RESEARCH_TRACE_FILE` (default empty; writes JSONL trace when set)

## Notes

- Gather stage requires `uv`, DCS project dependencies, YAMS daemon, and LM Studio endpoint.
- Critic stage falls back to heuristic output if model call/parsing fails.
- Reload Pi (`/reload`) after installing/updating extension.
