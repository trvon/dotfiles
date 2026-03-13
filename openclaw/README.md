# OpenClaw Image

Custom OpenClaw image for Jan integration with:

- Ubuntu 24.04 userspace for newer `glibc`
- `yams` preinstalled from the YAMS apt repo
- OpenClaw installed from npm and pinned by build arg

## Build

```bash
docker build -t ghcr.io/trevon/openclaw-yams:local -f openclaw/Dockerfile .
```

## Run With Jan

```bash
docker rm -f jan-openclaw 2>/dev/null || true

mkdir -p ~/.openclaw/sandbox/docker
mkdir -p ~/.openclaw/sandbox/docker-apt-cache
mkdir -p ~/.openclaw/sandbox/docker-apt-lists
mkdir -p ~/research

docker run -d \
  --name jan-openclaw \
  --restart unless-stopped \
  --user root \
  -p 127.0.0.1:18789:18789 \
  --memory 2g \
  --cpus 1 \
  --pids-limit 256 \
  --add-host host.docker.internal:host-gateway \
  --tmpfs /tmp:rw,exec,nosuid,size=1g \
  --tmpfs /home/node/.npm:rw,exec,nosuid,size=512m \
  --tmpfs /home/node/.cache:rw,exec,nosuid,size=512m \
  -v ~/.openclaw/sandbox/docker:/home/node/.openclaw \
  -v ~/.openclaw/sandbox/docker-apt-cache:/var/cache/apt \
  -v ~/.openclaw/sandbox/docker-apt-lists:/var/lib/apt/lists \
  -v ~/research:/workspace/research \
  -e HOME=/home/node \
  -e OPENCLAW_CONFIG=/home/node/.openclaw/openclaw.json \
  -e NODE_OPTIONS=--max-old-space-size=1536 \
  ghcr.io/trevon/openclaw-yams:latest
```

## Notes

- Jan inside Docker should use `http://host.docker.internal:1337/v1`.
- For WhatsApp in Docker, use `/home/node/.openclaw/whatsapp_auth` as the auth dir.
- Mount your own working data separately, for example `~/research:/workspace/research`.
- Running as `root` is intentional for a mutable dev container. Tighten this later if needed.
