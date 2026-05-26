# Hermes + Sage Dev Container Notes

This directory owns the local Hermes Docker setup used to run Hermes Agent with MiniMax and a source-built Sage Protocol toolchain.

## Container Shape

- Compose service: `hermes` in `hermes/compose.yml`
- Container name: `hermes-local`
- Persisted Hermes home: host `${HOME}/.hermes` mounted at `/opt/data`
- Main workspace mounts:
  - dotfiles: `/workspace/dotfiles`
  - research: `/workspace/research`
  - Sage CLI source: `/workspace/sage`
  - Sage Hermes plugin source: `/workspace/sage-hermes`
  - Sage Python SDK source: `/workspace/sage-plugin-sdk-py`

Runtime bind mounts are only available after the container is created. They are **not** available during `docker build` unless added as explicit Docker build contexts.

## MiniMax Coding Plan

Hermes uses MiniMax through the built-in `minimax` provider.

Expected persisted config in `/opt/data/config.yaml`:

```yaml
model:
  provider: minimax
  default: MiniMax-M2.7
```

Expected env in `hermes/.env`:

```env
MINIMAX_API_KEY=<MiniMax Coding/Token Plan key>
MINIMAX_BASE_URL=https://api.minimax.io/anthropic
```

After env changes, recreate the container rather than only restarting it:

```bash
docker compose -f hermes/compose.yml up -d --force-recreate hermes
```

Smoke test Hermes API:

```bash
API_KEY=$(grep '^API_SERVER_KEY=' hermes/.env | cut -d= -f2-)
curl -sS http://127.0.0.1:8642/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"hermes-agent","messages":[{"role":"user","content":"Reply with exactly: pong"}],"max_tokens":8}'
```

## Source-build Sage in the Running Container

The image includes Rust/Cargo and native Linux build dependencies, but the Sage source is mounted at runtime. Build from inside the container:

```bash
docker compose -f hermes/compose.yml exec -T hermes sh -lc '
  cd /workspace/sage &&
  CARGO_TARGET_DIR=/workspace/sage/target/hermes-linux-x64 cargo build -p sage -p sage-daemon
'
```

Install the source-built Linux binaries into the running container:

```bash
docker compose -f hermes/compose.yml exec -T hermes sh -lc '
  install -m 0755 /workspace/sage/target/hermes-linux-x64/debug/sage /usr/local/bin/sage &&
  install -m 0755 /workspace/sage/target/hermes-linux-x64/debug/saged /usr/local/bin/saged &&
  sage --version && saged --version
'
```

This install is in the current container filesystem. If the container is recreated, rerun the build/install or add an entrypoint bootstrap.

## Sage Python Project Setup

When pip cannot reach PyPI from the container, link the mounted local Python sources directly into site-packages with `.pth` files:

```bash
docker compose -f hermes/compose.yml exec -T hermes sh -lc '
  SITE=/usr/local/lib/python3.13/dist-packages
  printf "%s\n" /workspace/sage-plugin-sdk-py/src > "$SITE/sage_plugin_sdk_local.pth"
  printf "%s\n" /workspace/sage-hermes/src > "$SITE/sage_hermes_local.pth"
'
```

Verify:

```bash
docker compose -f hermes/compose.yml exec -T hermes sh -lc '
  python3 - <<PY
import sage_plugin_sdk, sage_hermes.plugin
print(sage_plugin_sdk.__file__)
print(sage_hermes.plugin.__file__)
PY
  cd /workspace/sage-hermes && PYTHONPATH=src:/workspace/sage-plugin-sdk-py/src python3 -m pytest -q
'
```

## Sage Hermes Plugin Setup

Install the plugin into the actual persisted Hermes home, not `/root/.hermes`:

```bash
docker compose -f hermes/compose.yml exec -T hermes sh -lc '
  mkdir -p /opt/data/plugins /opt/data/sage-hermes
  ln -sfn /workspace/sage-hermes /opt/data/plugins/sage-hermes
  cp -n /workspace/sage-hermes/config.example.yaml /opt/data/sage-hermes/config.yaml || true
  HERMES_HOME=/opt/data hermes plugins list
'
```

Smoke check the bridge:

```bash
docker compose -f hermes/compose.yml exec -T hermes sh -lc '
  python3 - <<PY
from sage_hermes.bridge import SageMcpBridge
b = SageMcpBridge(command="sage", args=["mcp", "start"], timeout_seconds=15)
try:
    b.ensure_started()
    print(b.status_snapshot())
    print([t.get("name") for t in b.list_tools()])
finally:
    b.stop()
PY
'
```

## Sage Wallet Setup

Default wallet posture is direct OWS wallet first.

Check posture:

```bash
docker compose -f hermes/compose.yml exec -T hermes sh -lc '
  sage wallet current || true
  sage wallet list || true
  sage wallet balance || true
'
```

For interactive OWS setup, keep a TTY attached so Sage can prompt for the passphrase:

```bash
docker compose -f hermes/compose.yml exec hermes sage wallet create sage-wallet
docker compose -f hermes/compose.yml exec hermes sage wallet connect ows -n sage-wallet
docker compose -f hermes/compose.yml exec hermes sage wallet current
```

For headless reconnect after a wallet already exists, store the passphrase outside the repo under persisted Hermes data with mode `0600`, then use `--credential-file`:

```bash
docker compose -f hermes/compose.yml exec -T hermes sh -lc '
  PASS_FILE=/opt/data/secrets/sage-wallet.passphrase
  test -f "$PASS_FILE"
  test "$(stat -c %a "$PASS_FILE")" = "600"
  sage wallet connect ows -n sage-wallet --credential-file "$PASS_FILE" --credential-kind passphrase --format text
  sage wallet current
'
```

Start/check daemon:

```bash
docker compose -f hermes/compose.yml exec -T hermes sh -lc '
  sage daemon start --watch || true
  sage daemon status
'
```
