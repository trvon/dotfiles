# Pi

Config for the [pi coding agent](https://github.com/earendil-works/pi)
(`@earendil-works/pi-coding-agent`, installed with npm under nvm).

This is a stow package: `stow --no-folding -t ~ pi` links each tracked file
into `~/.pi/agent/`. `README.md` and `archive/` are skipped (`.stow-local-ignore`).

## Tracked

| File | Purpose |
|------|---------|
| `.pi/agent/settings.json` | Default model (`deepseek/deepseek-v4-flash`, thinking `high`), theme, package list |
| `.pi/agent/models.json` | Custom `server` provider (RunInfra OpenAI-compatible endpoint); key read from `$RUNINFRA_API_KEY` |
| `.pi/agent/AGENTS.md` | Global instructions loaded into every session |
| `.pi/agent/npm/package.json` | Pinned versions of the installed pi packages |
| `.pi/agent/skills/humanizer.md` | Hand-added skill |

## Packages

Listed in `settings.json` under `packages` and installed into `~/.pi/agent/npm`:

- `@trevonistrevon/pi-loop`: loops and task management
- `pi-subagents`, `pi-intercom`: subagents and cross-session messaging
- `pi-web-access`, `pi-mcp-adapter`: web search/fetch and MCP servers
- `lsp-pi`, `pi-lens`, `pi-tscg`: code intelligence
- `pi-prompt-template-model`: prompt templates with per-template models
- `pi-runinfra`: RunInfra provider
- `@sage-protocol/pi-adapter`: Sage integration

## Skills not tracked here

- **Cloudflare bundle** (agents-sdk, cloudflare, wrangler, durable-objects, ...):
  installed from Cloudflare's skills set.
- **Sage skills** (`sage-*`, `prompt-builder`): managed by sage (`.sage-managed.json`).

Reinstall those from their sources rather than copying them in.

## Never track

`auth.json`, `models-store.json*`, `*.bak-*`, `run-history.jsonl`, `trust.json`,
`sessions/`, `intercom/`, `missions/`, `web-search-cache/`, `bin/`, `npm/node_modules`,
and everything under `~/.pi/{loops,pi-acp,tasks}`. These are credentials or runtime state.

## Archive

`archive/` holds the previous custom harness (extensions, tests, MLX wrapper,
model routing). It is not installed; see `archive/README.md`.
