# Pi Context Plugin

Local OpenClaw plugin workspace for porting the Pi context manager and RLM tools
into the OpenClaw gateway.

## Goal

Expose the useful Pi-side context features to OpenClaw without dragging the full
Pi harness into the gateway:

- RLM retrieval/status
- session context briefing
- optional deep recall
- background sidecar model for context tasks

## Current status

Implemented in the first pass:

- `/rlm` command
- `before_prompt_build` hook that injects recalled YAMS snippets into system context
- background LM Studio sidecar query-refinement step using `sidecarModel`
- `agent_end` hook for automatic post-turn memory extraction and YAMS storage using the same sidecar model
- continuity watchdog that marks incomplete/aborted turns and injects recovery guidance on the next turn
- activity heartbeat that refreshes RLM for tracked sessions after inactivity

Deferred:

- DCS / `research-agent` integration
- model-based context summarization using a sidecar model

Design intent:

- the user should not need to call plugin tools explicitly
- the main OpenClaw agent can stay on the larger model
- `sidecarModel` is used for background context-management work
- completed turns are automatically distilled into compact memory chunks and stored in YAMS

The intent is to keep this plugin maintained in dotfiles and installed locally
with:

```bash
openclaw plugins install ./openclaw/extensions/pi-context
```

## Why a plugin here

OpenClaw's native extension surface is plugins, not Pi extensions. A plugin is
the clean place to expose:

- agent tools
- slash/CLI commands
- gateway hooks that inject recalled context
- plugin-specific config

This repo did not previously have a custom plugin area. `openclaw/extensions/`
is the natural place to keep local OpenClaw plugins in this dotfiles repo.

## Scope

Port from local Pi code:

- `pi/extensions/hybrid-optimizer.ts`
  - RLM retrieval/store flow
  - session memory status command
  - DCS deep recall command
- `pi/README.md`
  - model routing defaults
  - timeout defaults
- `pi/models.json`
  - small-model sidecar ids

Related external repo:

- `https://github.com/trvon/agents-dcs`
  - `dcs/cli.py`
  - `dcs/pipeline.py`
  - `dcs/lmstudio_context.py`

## Recommended implementation order

1. Session context management
   - persistent session id
   - retrieve from YAMS before agent turn
   - compact briefing text inserted into system context
   - sidecar-assisted query refinement before retrieval
   - sidecar-assisted extraction of durable memory after completed turns
2. DCS later
   - `/rlm-deep-recall <topic>` command
   - only after we decide whether to shell out to `research-agent` or reimplement a lighter in-process path

## Runtime notes

The current OpenClaw Docker image does not include the full DCS runtime:

- no `uv`
- no Python package sync
- no `research-agent` CLI install
- no mount for the external DCS repo

So the first plugin pass targets YAMS-backed RLM and context injection. DCS
stays optional.

## Proposed plugin config

`plugins.entries.pi-context.config`

- `enabledRlm` - enable YAMS-backed RLM retrieval/store features
- `enabledDcs` - enable deep recall features
- `yamsBinary` - default `yams`
- `yamsCwd` - repo scope for retrieval
- `rlmCollection` - default `pi-session-memory`
- `rlmGlobalTag` - default `rlm-openclaw`
- `rlmSimilarity` - default `0.001`
- `rlmLimit` - default `3`
- `rlmBaseMinScore` - default `0.003`
- `rlmDynamicPolicy` - default `true` (adapts min score from retrieval quality/noise)
- `autoStore` - default `true`
- `storeLimit` - default `3`
- `continuityWatchdogEnabled` - default `true`
- `continuityMaxRetries` - default `1`
- `continuityCooldownMs` - default `120000`
- `activityHeartbeatEnabled` - default `true`
- `activityHeartbeatMs` - default `1800000`
- `activityHeartbeatPollMs` - default `300000`
- `lmstudioBaseUrl` - default `http://host.docker.internal:1234/v1`
- `sidecarModel` - default background model for extractor/briefing tasks (`qwen_qwen3.5-9b`)
- `dcsCli` - default `research-agent`
- `dcsContextProfile` - default `small`

## Porting notes

- Pi's current RLM implementation is tightly coupled to Pi extension lifecycle.
  That logic needs to be rewritten against OpenClaw plugin hooks.
- DCS in `agents-dcs` is a larger Python pipeline. Treat it as optional and
  external for the first version.
- The first usable plugin version should prefer direct `yams` CLI calls and
  lightweight prompt assembly over attempting a full Pi-to-OpenClaw transplant.
