# Hermes Local Container

Repo-local Hermes setup wired to MiniMax through Hermes Agent's built-in `minimax` provider, using `MiniMax-M2.7` by default.

This version keeps Hermes simple:

- Hermes runs in Docker
- terminal commands run locally inside the Hermes container
- MiniMax runs remotely through `MINIMAX_API_KEY` from `hermes/.env`
- no Docker socket or child sandbox containers
- on Apple Silicon, the container runs as `linux/amd64` because the upstream Hermes image is not publishing a native arm64 manifest here
- Hermes's OpenAI-compatible API server is enabled on `http://127.0.0.1:8642/v1`
- secrets live in `hermes/.env`, which is gitignored
- YAMS is preinstalled in the image and exposed to Hermes through MCP as a read-only `query` server
- SearXNG runs as an internal-only sidecar and is exposed to Hermes through MCP web search

## What Gets Bootstrapped

On first start, the custom entrypoint seeds `~/.hermes/config.yaml` with these defaults:

- `model.provider: minimax`
- `model.default: MiniMax-M2.7`
- `model.context_length: 204800`
- `terminal.backend: local`
- `terminal.cwd: /workspace/dotfiles`
- text-only auxiliary tasks routed to the same MiniMax model
- `mcp_servers.searxng` configured to use the internal `searxng` service
- `mcp_servers.yams` configured to use the in-container YAMS daemon

The same entrypoint also initializes YAMS on first boot, starts the YAMS daemon inside the container, and persists its state in the Docker volume `hermes_yams` mounted at `/opt/data/yams`.

This is container-local bootstrap logic. A proper host install service for YAMS belongs upstream in the YAMS project rather than in this dotfiles container.

If `~/.hermes/config.yaml` already exists, it is left alone. If you already have a Hermes config that points somewhere else, edit or remove it before first boot if you want these defaults to take effect.

## Start

```bash
mkdir -p ~/.hermes
mkdir -p ~/research
cp hermes/.env.example hermes/.env
# edit hermes/.env and set MINIMAX_API_KEY

docker compose -f hermes/compose.yml up -d --build
```

`hermes/.env` is the repo-local secret file used for API keys, Matrix credentials, and API server auth. It is ignored by git.

Follow logs:

```bash
docker compose -f hermes/compose.yml logs -f hermes
```

Open an interactive Hermes session against the same persisted state:

```bash
docker compose -f hermes/compose.yml run --rm hermes chat
```

## Configure MiniMax

Hermes has a first-class `minimax` provider. Put your MiniMax key in the repo-local env file used by Compose:

```bash
cp hermes/.env.example hermes/.env
$EDITOR hermes/.env  # set MINIMAX_API_KEY=...
```

By default, Hermes uses the MiniMax global endpoint (`https://api.minimax.io/v1`) and `MiniMax-M2.7`. If you need to override the endpoint, uncomment `MINIMAX_BASE_URL` in `hermes/.env`. MiniMax's Hermes guide recommends Token Plan API keys for Hermes Agent.

Quick key/model check from the container:

```bash
docker compose -f hermes/compose.yml run --rm hermes \
  python3 -c "import os, urllib.request; req=urllib.request.Request('https://api.minimax.io/v1/models', headers={'Authorization': 'Bearer '+os.environ['MINIMAX_API_KEY']}); print(urllib.request.urlopen(req, timeout=30).read().decode()[:1000])"
```

## YAMS MCP

YAMS is installed in the Hermes image using the same apt-repo pattern as `openclaw/Dockerfile` and is wired into Hermes via `mcp_servers.yams`.

Persistent YAMS state lives in the Docker volume:

```text
hermes_yams
```

Inside the container that volume is mounted at:

```text
/opt/data/yams
```

Quick checks:

```bash
docker exec hermes-local yams daemon status --socket /tmp/yams-daemon.sock
docker exec hermes-local yams grep "OpenClaw Image" /workspace/dotfiles
```

Hermes sees YAMS through MCP with read-only `query` access first. MCP resource/prompt wrappers are disabled here to keep the surface minimal and avoid utility-wrapper issues.

## SearXNG MCP

The stack includes a local SearXNG sidecar service using the same config directory as `openclaw`:

```text
openclaw/searxng/
```

It is internal to the Hermes Compose network and is not published on a host port.

Hermes reaches it through MCP using:

```text
http://searxng:8080
```

Quick checks:

```bash
docker compose -f hermes/compose.yml ps
docker exec hermes-local curl -sf "http://searxng:8080/search?q=health&format=json"
```

Hermes is configured to expose only the `searxng_web_search` MCP tool from this sidecar.

## API Server

The container publishes Hermes's OpenAI-compatible API server on:

```text
http://127.0.0.1:8642/v1
```

The bearer token is stored in `hermes/.env` as `API_SERVER_KEY`.

Quick health checks:

```bash
curl http://127.0.0.1:8642/health
curl http://127.0.0.1:8642/v1/models \
  -H "Authorization: Bearer $(grep '^API_SERVER_KEY=' hermes/.env | cut -d= -f2-)"
```

## Notes

- The bundled config routes text-only auxiliary tasks to `MiniMax-M2.7` as well. Vision is not explicitly configured here.
- The container mounts this repo at `/workspace/dotfiles` and `~/research` at `/workspace/research`.
- The image adds `git` and `curl` on top of the official Hermes container so coding tasks inside the repo work normally.
- Runtime secrets are injected from `hermes/.env`; the mounted `~/.hermes/.env` can stay free of local credentials.
- Inspect the YAMS volume with `docker volume inspect hermes_yams`.
- Open a shell against the YAMS volume with `docker run --rm -it -v hermes_yams:/data alpine sh`.
