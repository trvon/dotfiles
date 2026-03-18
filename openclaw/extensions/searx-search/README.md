# SearX Search Plugin

Local OpenClaw plugin that exposes `searx_search` and `searx_status` tools backed by a self-hosted SearXNG instance.

## Install

```bash
openclaw plugins install ./openclaw/extensions/searx-search
```

## Expected SearX endpoint

- `http://127.0.0.1:8888/search?format=json&q=...`

## Tools

- `searx_status` - health/config check
- `searx_search` - normalized search results

## Suggested OpenClaw config entry

```json
{
  "plugins": {
    "allow": ["pi-context", "openclaw-sage", "telegram", "searx-search"],
    "load": {
      "paths": [
        "/Users/trevon/Documents/depend/dotfiles/openclaw/extensions/pi-context",
        "/Users/trevon/Documents/depend/dotfiles/openclaw/extensions/searx-search"
      ]
    },
    "entries": {
      "searx-search": {
        "enabled": true,
        "config": {
          "enabled": true,
          "baseUrl": "http://127.0.0.1:8888",
          "defaultLanguage": "en-US",
          "safeSearch": 1,
          "defaultMaxResults": 8,
          "timeoutMs": 10000,
          "engines": ["duckduckgo", "brave", "qwant"]
        }
      }
    }
  }
}
```

## Notes

- This plugin adds `searx_search` and does not override OpenClaw's built-in `web_search` tool.
- Cron prompts can be migrated gradually from `web_search` to `searx_search`.
