# OpenClaw Image

Local focused OpenClaw container

- `yams` preinstalled from the YAMS apt repo
- OpenClaw installed from npm and pinned by build arg
- Docker CLI preinstalled so OpenClaw can launch child sandbox containers

## Build

```bash
docker build -t openclaw-yams:local -f openclaw/Dockerfile .
```

```bash
docker rm -f jan-openclaw 2>/dev/null || true

mkdir -p ~/.openclaw/sandbox/docker
mkdir -p ~/.openclaw/sandbox/docker/sandboxes
mkdir -p ~/research

docker compose -f openclaw/compose.yml up -d --build
```

If you want to keep using `docker run`, this already has the right recovery flag:

```bash
docker run -d \
  --name jan-openclaw \
  --restart unless-stopped \
  --user root \
  -p 127.0.0.1:18789:18789 \
  -p 127.0.0.1:18791:18791 \
  --pids-limit 256 \
  --add-host host.docker.internal:host-gateway \
  --tmpfs /tmp:rw,exec,nosuid,size=1g \
  --tmpfs /home/node/.npm:rw,exec,nosuid,size=512m \
  --tmpfs /home/node/.cache:rw,exec,nosuid,size=512m \
  -v ~/.openclaw/sandbox/docker:/home/node/.openclaw \
  -v ~/.openclaw/sandbox/docker:/Users/trevon/.openclaw/sandbox/docker \
  -v ~/research:/workspace/research \
  -v ~/research:/Users/trevon/research \
  -v ~/Documents/depend/dotfiles:/workspace/dotfiles \
  -v ~/Documents/depend/dotfiles:/Users/trevon/Documents/depend/dotfiles \
  -v /var/run/docker.sock:/var/run/docker.sock \
  openclaw-yams:local
```

The duplicate absolute-path mounts are intentional: Docker-backed child sandboxes need host-real paths that exist identically inside the gateway container.

## Pi Context Plugin

Local plugin workspace:

- [openclaw/extensions/pi-context/README.md](/Users/trevon/Documents/depend/dotfiles/openclaw/extensions/pi-context/README.md)

Install it into OpenClaw:

```bash
openclaw plugins install ./openclaw/extensions/pi-context
```

Recommended plugin config for this repo:

```json
{
  "plugins": {
    "entries": {
      "pi-context": {
        "enabled": true,
        "config": {
          "enabledRlm": true,
          "enabledDcs": false,
          "yamsCwd": "/workspace/dotfiles",
          "rlmCollection": "pi-session-memory",
          "rlmSimilarity": 0.001,
          "rlmLimit": 3,
          "sidecarModel": "qwen_qwen3.5-4b"
        }
      }
    }
  }
}
```

## SearXNG + Search Plugin

This repo now includes a local SearXNG service and custom OpenClaw plugin:

- service: `openclaw-searxng` on `http://127.0.0.1:8888`
- plugin: `openclaw/extensions/searx-search`

Start stack:

```bash
docker compose -f openclaw/compose.yml up -d searxng jan-openclaw
```

Install plugin:

```bash
openclaw plugins install ./openclaw/extensions/searx-search
```

Verify tools:

```bash
openclaw tool run searx_status '{}'
openclaw tool run searx_search '{"query":"ios zero day","maxResults":5}'
```

Canary rollout suggestion:

1. Update `urgent-news-search` prompt to prefer `searx_search`
2. Keep built-in `web_search` as fallback in prompts during canary
3. Expand to research/threat/mobile search jobs after 24-48h stable runs

## Notes

- For WhatsApp in Docker, use `/home/node/.openclaw/whatsapp_auth` as the auth dir.
- Mount your own working data separately, for example `~/research:/workspace/research`.
- Running as `root` is intentional here so OpenClaw can access `/var/run/docker.sock` and launch child sandboxes.
