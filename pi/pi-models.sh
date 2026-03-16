#!/usr/bin/env bash
# pi-models.sh — Start/stop model server instances for Pi AI coding agent.
#
# Supports two backends (configured via settings.json "defaultProvider"):
#   mlx        — MLX-LM server (fast MoE generation on Apple Silicon)
#   llama-cpp  — llama.cpp server (GGUF quantization)
#
# Port assignments are centralized in settings.json → "ports":
#   { "mlx": { "primary": 8080, "sidecar": 8081 },
#     "llama-cpp": { "primary": 8090, "sidecar": 8091 } }
# On start, models.json baseUrl fields are auto-synced from settings.json.
# Manual sync: pi-models.sh sync-ports
#
# MLX mode launches:
#   PRIMARY  (port from settings.json, default 8080): Qwen3.5-35B-A3B 8-bit via mlx_lm.server
#   SIDECAR  (port from settings.json, default 8081): Qwen3.5-9B 8-bit via mlx_lm.server
#
# llama-cpp mode launches:
#   PRIMARY  (port from settings.json, default 8090): Qwen3.5-35B-A3B UD-Q8_K_XL via llama-server
#   SIDECAR  (port from settings.json, default 8091): Qwen3.5-9B UD-Q8_K_XL via llama-server
#
# Usage:
#   pi-models.sh start [mlx|llama-cpp]   Start servers (auto-detects from settings.json)
#   pi-models.sh stop                    Gracefully stop all servers
#   pi-models.sh restart                 Stop then start
#   pi-models.sh status                  Show running state and health
#   pi-models.sh logs [name]             Tail logs (primary|sidecar|all, default: all)
#   pi-models.sh sync-ports              Sync models.json baseUrl from settings.json ports
#
# Environment overrides (take precedence over settings.json):
#   PI_BACKEND           (default: auto-detect from settings.json)
#   PI_PRIMARY_PORT      (overrides settings.json port for primary)
#   PI_SIDECAR_PORT      (overrides settings.json port for sidecar)
#   PI_PRIMARY_CTX       (default: 262144)
#   PI_SIDECAR_CTX       (default: 262144)
#   PI_SIDECAR_SLOTS     (default: 4)
#   PI_MODELS_DIR        (default: ~/.pi/agent)
#   PI_LLAMA_SERVER      (default: llama-server from PATH)
#   PI_MLX_VENV          (default: ~/.pi/mlx-env)
#   PI_MLX_KV_BITS       (default: empty=off. Set to 8 for long-context sessions)
#   PI_MLX_KV_GROUP_SIZE (default: 64)
#   PI_MLX_KV_START      (default: 1024, tokens before switching to quantized KV)
#   PI_HF_CACHE_DIR      (default: ~/.cache/huggingface/hub)
#   PI_MLX_PRIMARY_LOCAL (preferred local path override for primary model)
#   PI_MLX_PRIMARY_REPO  (repo fallback for primary model)
#   PI_MLX_SIDECAR_LOCAL (preferred local path override for sidecar model)
#   PI_MLX_SIDECAR_REPO  (repo fallback for sidecar model)
#
set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODELS_DIR="${PI_MODELS_DIR:-$SCRIPT_DIR}"
LLAMA_SERVER="${PI_LLAMA_SERVER:-/Users/trevon/Documents/depend/llama.cpp/build/bin/llama-server}"

# MLX virtual environment
MLX_VENV="${PI_MLX_VENV:-$HOME/.pi/mlx-env}"
MLX_PYTHON="$MLX_VENV/bin/python3"
MLX_WRAPPER="$MODELS_DIR/mlx-server-wrapper.py"

# ── Backend detection ──────────────────────────────────────────────────────────
# Reads defaultProvider from settings.json, or uses PI_BACKEND env var override.
# Accepts explicit override as argument: pi-models.sh start mlx

detect_backend() {
  # 1. Explicit arg (from cmd_start)
  if [[ -n "${1:-}" ]]; then
    echo "$1"
    return
  fi
  # 2. Environment override
  if [[ -n "${PI_BACKEND:-}" ]]; then
    echo "$PI_BACKEND"
    return
  fi
  # 3. Read from settings.json
  local settings="$MODELS_DIR/settings.json"
  if [[ -f "$settings" ]]; then
    local provider
    provider=$(python3 -c "import json; print(json.load(open('$settings')).get('defaultProvider',''))" 2>/dev/null || echo "")
    if [[ "$provider" == "mlx" ]]; then
      echo "mlx"
      return
    fi
  fi
  # 4. Default
  echo "llama-cpp"
}

BACKEND="${PI_BACKEND:-}"

# ── Port configuration (single source of truth: settings.json → ports) ────────
# Reads ports.{backend}.primary and ports.{backend}.sidecar from settings.json.
# Env vars PI_PRIMARY_PORT / PI_SIDECAR_PORT override if set.
# Fallback defaults: llama-cpp 8090/8091, mlx 8080/8081

SETTINGS_JSON="$MODELS_DIR/settings.json"
MODELS_JSON="$MODELS_DIR/models.json"

# Read a port from settings.json: read_port <backend> <role>
# e.g. read_port llama-cpp primary → 8090
read_port() {
  local backend="$1" role="$2"
  if [[ -f "$SETTINGS_JSON" ]]; then
    python3 -c "
import json, sys
d = json.load(open('$SETTINGS_JSON'))
p = d.get('ports', {}).get('$backend', {}).get('$role', '')
if p: print(p)
else: sys.exit(1)
" 2>/dev/null && return 0
  fi
  return 1
}

# Sync models.json baseUrl fields to match ports in settings.json.
# Called automatically on start, or manually via: pi-models.sh sync-ports
sync_ports() {
  if [[ ! -f "$SETTINGS_JSON" ]] || [[ ! -f "$MODELS_JSON" ]]; then
    warn "Cannot sync ports: settings.json or models.json not found"
    return 1
  fi

  python3 -c "
import json, sys

settings_path = '$SETTINGS_JSON'
models_path = '$MODELS_JSON'

with open(settings_path) as f:
    settings = json.load(f)

with open(models_path) as f:
    models = json.load(f)

ports = settings.get('ports', {})
if not ports:
    print('[pi-models] No ports section in settings.json, skipping sync', file=sys.stderr)
    sys.exit(0)

# Map provider keys in models.json → (backend, role) in settings.json ports
provider_port_map = {
    'mlx':               ('mlx', 'primary'),
    'mlx-sidecar':       ('mlx', 'sidecar'),
    'llama-cpp':         ('llama-cpp', 'primary'),
    'llama-cpp-sidecar': ('llama-cpp', 'sidecar'),
}

changed = False
providers = models.get('providers', {})
for provider_key, (backend, role) in provider_port_map.items():
    if provider_key not in providers:
        continue
    port = ports.get(backend, {}).get(role)
    if port is None:
        continue
    expected_url = f'http://localhost:{port}/v1'
    current_url = providers[provider_key].get('baseUrl', '')
    if current_url != expected_url:
        providers[provider_key]['baseUrl'] = expected_url
        changed = True
        print(f'[pi-models] sync: {provider_key} baseUrl → {expected_url}')

if changed:
    with open(models_path, 'w') as f:
        json.dump(models, f, indent=2)
        f.write('\n')
    print('[pi-models] models.json ports synced from settings.json')
else:
    print('[pi-models] models.json ports already in sync')
"
}

# Context sizes (Qwen3.5-35B-A3B native max: 262144)
# Hybrid attention: only 16/64 layers use full KV cache -> modest KV footprint at 262k
PRIMARY_CTX="${PI_PRIMARY_CTX:-262144}"
SIDECAR_CTX="${PI_SIDECAR_CTX:-262144}"

# ── Performance tuning ─────────────────────────────────────────────────────────
# Tuned for Apple Silicon M4 Max (12P + 4E cores, 128 GB unified memory)

# GPU: offload all layers to Metal (999 = everything)
GPU_LAYERS="${PI_GPU_LAYERS:-999}"

# Flash attention: forced ON for Metal (significant speedup on Apple Silicon)
FLASH_ATTN="on"

# KV cache type: f16 (native precision)
# Benchmarks show q8_0 KV costs 20-55% throughput on Qwen3.5 MoE/hybrid models.
# With 81 GB headroom on M4 Max 128 GB, f16 is the right call.
KV_CACHE_TYPE_K="${PI_KV_TYPE_K:-f16}"
KV_CACHE_TYPE_V="${PI_KV_TYPE_V:-f16}"

# Continuous batching: on (handles concurrent requests efficiently)
CONT_BATCHING="on"

# Batch sizes: larger = faster prompt processing
# batch-size: logical max batch (tokens processed per iteration)
# ubatch-size: physical max batch (actual GPU dispatch size)
BATCH_SIZE="${PI_BATCH_SIZE:-4096}"
UBATCH_SIZE="${PI_UBATCH_SIZE:-1024}"

# Threading: P-cores only for generation, all cores for prompt processing
# M4 Max: 12 P-cores, 16 total — let llama.cpp auto-detect is fine for gen
# but we force batch threads high for fast prompt ingestion
THREADS="${PI_THREADS:--1}"
THREADS_BATCH="${PI_THREADS_BATCH:-16}"

# Parallelism: 4 slots each — primary has headroom (93 GB / 115 GB with 4 slots at 262k f16)
# Sidecar already at 4 slots (65k ctx = much smaller KV cache per slot)
PRIMARY_SLOTS="${PI_PRIMARY_SLOTS:-4}"
SIDECAR_SLOTS="${PI_SIDECAR_SLOTS:-4}"

# mlock: keep model weights pinned in RAM (prevents macOS memory pressure eviction)
MLOCK="on"

# Polling: 100% = busy-wait for lowest latency (at cost of CPU usage when idle)
POLL="${PI_POLL:-100}"

# Process priority: 2 = high (less scheduling jitter during generation)
# 0=normal, 1=medium, 2=high, 3=realtime
PRIO="${PI_PRIO:-2}"
PRIO_BATCH="${PI_PRIO_BATCH:-2}"

# Cache reuse: reuse KV cache via shifting when requests share a common prefix
# Pi sends full conversation each request, so this avoids recomputing the entire
# context on each turn. 256 = minimum shared prefix length (tokens) to trigger reuse.
CACHE_REUSE="${PI_CACHE_REUSE:-256}"

# Sampling — Unsloth-recommended Qwen 3.5 settings
# Profile: "Thinking mode, precise coding"
# https://huggingface.co/unsloth/Qwen3.5-35B-A3B-GGUF
SAMPLING_TEMP="0.6"
SAMPLING_TOP_P="0.95"
SAMPLING_TOP_K="20"
SAMPLING_MIN_P="0"
SAMPLING_PRESENCE_PENALTY="0"

# HuggingFace model repos (with :quant suffix for auto-download)
PRIMARY_HF="unsloth/Qwen3.5-35B-A3B-GGUF:UD-Q8_K_XL"
SIDECAR_HF="unsloth/Qwen3.5-9B-GGUF:UD-Q8_K_XL"

# MLX model paths/repos
# Source resolution order (per role): local path -> complete HF cache snapshot -> repo id.
MLX_CACHE_ROOT="${PI_HF_CACHE_DIR:-$HOME/.cache/huggingface/hub}"

MLX_PRIMARY_LOCAL="${PI_MLX_PRIMARY_LOCAL:-$HOME/.pi/benchmarks/qwen35-quants/Qwen3.5-35B-A3B-8bit}"
MLX_PRIMARY_REPO="${PI_MLX_PRIMARY_REPO:-mlx-community/Qwen3.5-35B-A3B-8bit}"

MLX_SIDECAR_LOCAL="${PI_MLX_SIDECAR_LOCAL:-}"
MLX_SIDECAR_REPO="${PI_MLX_SIDECAR_REPO:-mlx-community/Qwen3.5-9B-8bit}"

MLX_PRIMARY_MODEL="$MLX_PRIMARY_REPO"
MLX_SIDECAR_MODEL="$MLX_SIDECAR_REPO"
MLX_PRIMARY_SOURCE="repo"
MLX_SIDECAR_SOURCE="repo"

# MLX server settings
# max-tokens: high default (mlx_lm.server defaults to 512 which is too low)
MLX_MAX_TOKENS="${PI_MLX_MAX_TOKENS:-32768}"
# decode-concurrency: batch decode multiple requests in parallel
MLX_DECODE_CONCURRENCY="${PI_MLX_DECODE_CONCURRENCY:-2}"
# prompt-concurrency: batch process multiple prompts in parallel
MLX_PROMPT_CONCURRENCY="${PI_MLX_PROMPT_CONCURRENCY:-2}"

# KV cache quantization (MLX only, via mlx-server-wrapper.py)
# At 262k context, FP16 KV cache = ~64 GB for Qwen3.5-35B-A3B — doesn't fit in 128 GB
# with the 20 GB model. 8-bit KV halves to ~32 GB (fits comfortably).
# Cost: ~34% gen speed regression at short context (overhead dominates), but
# essential for memory-fit at long context (10k+ tokens).
# Set to 8 for long-context sessions. Leave empty for short sessions (FP16 KV).
MLX_KV_BITS="${PI_MLX_KV_BITS:-}"
MLX_KV_GROUP_SIZE="${PI_MLX_KV_GROUP_SIZE:-64}"
MLX_KV_START="${PI_MLX_KV_START:-1024}"

# Aliases (used in OpenAI-compatible API as model names)
PRIMARY_ALIAS="qwen3.5-35b-a3b"
SIDECAR_ALIAS="qwen3.5-9b"

# PID and log files — llama-cpp
PRIMARY_PID="$MODELS_DIR/llama-primary.pid"
SIDECAR_PID="$MODELS_DIR/llama-sidecar.pid"
PRIMARY_LOG="$MODELS_DIR/llama-primary.log"
SIDECAR_LOG="$MODELS_DIR/llama-sidecar.log"

# PID and log files — MLX
MLX_PRIMARY_PID="$MODELS_DIR/mlx-primary.pid"
MLX_SIDECAR_PID="$MODELS_DIR/mlx-sidecar.pid"
MLX_PRIMARY_LOG="$MODELS_DIR/mlx-primary.log"
MLX_SIDECAR_LOG="$MODELS_DIR/mlx-sidecar.log"

# Slot save paths — persist KV cache to disk so it survives server restarts
PRIMARY_SLOT_SAVE="$MODELS_DIR/cache/primary"
SIDECAR_SLOT_SAVE="$MODELS_DIR/cache/sidecar"

# Health check
HEALTH_TIMEOUT=600       # seconds — first run downloads ~30 GB total (smaller model)
HEALTH_INTERVAL=3        # seconds between health checks

# ── Helpers ────────────────────────────────────────────────────────────────────

log()  { printf '[pi-models] %s\n' "$*"; }
warn() { printf '[pi-models] WARNING: %s\n' "$*" >&2; }
die()  { printf '[pi-models] ERROR: %s\n' "$*" >&2; exit 1; }

is_running() {
  local pid_file="$1"
  [[ -f "$pid_file" ]] || return 1
  local pid
  pid=$(cat "$pid_file" 2>/dev/null) || return 1
  kill -0 "$pid" 2>/dev/null
}

get_pid() {
  local pid_file="$1"
  [[ -f "$pid_file" ]] && cat "$pid_file" 2>/dev/null || echo ""
}

is_complete_mlx_model_dir() {
  local model_dir="$1"
  [[ -d "$model_dir" ]] || return 1
  [[ -f "$model_dir/config.json" ]] || return 1

  python3 - "$model_dir" <<'PY'
import json
import sys
from pathlib import Path

model_dir = Path(sys.argv[1])
index_file = model_dir / "model.safetensors.index.json"

if index_file.exists():
    try:
        data = json.loads(index_file.read_text())
        weight_map = data.get("weight_map") or {}
        shard_files = sorted(set(weight_map.values()))
        if not shard_files:
            raise SystemExit(1)
        missing = [name for name in shard_files if not (model_dir / name).exists()]
        raise SystemExit(0 if not missing else 1)
    except Exception:
        raise SystemExit(1)

safetensors = list(model_dir.glob("model*.safetensors"))
raise SystemExit(0 if safetensors else 1)
PY
}

resolve_mlx_model_source() {
  local local_path="$1"
  local repo_id="$2"

  if [[ -n "$local_path" ]] && is_complete_mlx_model_dir "$local_path"; then
    printf '%s\t%s\n' "$local_path" "local"
    return 0
  fi

  local cache_key
  cache_key="${repo_id//\//--}"
  local cache_repo_root="$MLX_CACHE_ROOT/models--$cache_key"
  local cache_snapshots="$cache_repo_root/snapshots"
  if [[ -d "$cache_snapshots" ]]; then
    local snapshot
    snapshot=$(python3 - "$cache_snapshots" <<'PY'
import sys
from pathlib import Path

root = Path(sys.argv[1])
dirs = [p for p in root.iterdir() if p.is_dir()]
if not dirs:
    print("")
else:
    dirs.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    print(str(dirs[0]))
PY
)
    if [[ -n "$snapshot" ]] && is_complete_mlx_model_dir "$snapshot"; then
      printf '%s\t%s\n' "$snapshot" "cache"
      return 0
    fi
  fi

  printf '%s\t%s\n' "$repo_id" "repo"
}

wait_for_health() {
  local name="$1" port="$2" timeout="$3"
  local url="http://localhost:${port}/health"
  local elapsed=0

  log "Waiting for $name to be ready on port $port..."
  while (( elapsed < timeout )); do
    local status
    status=$(curl -sf "$url" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
    if [[ "$status" == "ok" ]]; then
      log "$name is ready (took ${elapsed}s)"
      return 0
    fi
    sleep "$HEALTH_INTERVAL"
    elapsed=$(( elapsed + HEALTH_INTERVAL ))
  done

  warn "$name did not become ready within ${timeout}s"
  return 1
}

wait_for_health_mlx() {
  local name="$1" port="$2" timeout="$3"
  local url="http://localhost:${port}/v1/models"
  local elapsed=0

  log "Waiting for MLX $name to be ready on port $port..."
  while (( elapsed < timeout )); do
    # MLX server is ready when /v1/models returns valid JSON with data array
    local ok
    ok=$(curl -sf "$url" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print('ok' if 'data' in d else '')" 2>/dev/null || echo "")
    if [[ "$ok" == "ok" ]]; then
      log "MLX $name is ready (took ${elapsed}s)"
      return 0
    fi
    sleep "$HEALTH_INTERVAL"
    elapsed=$(( elapsed + HEALTH_INTERVAL ))
  done

  warn "MLX $name did not become ready within ${timeout}s"
  return 1
}

stop_server() {
  local name="$1" pid_file="$2"
  if is_running "$pid_file"; then
    local pid
    pid=$(get_pid "$pid_file")
    log "Stopping $name (PID $pid)..."
    kill "$pid" 2>/dev/null || true
    # Wait up to 10s for graceful shutdown
    local i=0
    while (( i < 10 )) && kill -0 "$pid" 2>/dev/null; do
      sleep 1
      i=$(( i + 1 ))
    done
    if kill -0 "$pid" 2>/dev/null; then
      warn "$name did not stop gracefully, sending SIGKILL"
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
    log "$name stopped"
  else
    log "$name is not running"
    rm -f "$pid_file"
  fi
}

# ── Commands ───────────────────────────────────────────────────────────────────

cmd_start() {
  local backend_arg="${1:-}"
  BACKEND=$(detect_backend "$backend_arg")

  # Sync models.json baseUrl ports from settings.json before starting servers
  sync_ports

  case "$BACKEND" in
    mlx)       cmd_start_mlx ;;
    llama-cpp) cmd_start_llama ;;
    *)         die "Unknown backend: $BACKEND (use mlx or llama-cpp)" ;;
  esac
}

# ── MLX start ──────────────────────────────────────────────────────────────────

cmd_start_mlx() {
  # Validate MLX environment
  [[ -x "$MLX_PYTHON" ]] || die "MLX venv not found at $MLX_VENV. Run: python3 -m venv $MLX_VENV && $MLX_VENV/bin/pip install mlx-lm"
  [[ -f "$MLX_WRAPPER" ]] || die "MLX wrapper not found at $MLX_WRAPPER"

  local mlx_primary_port="${PI_PRIMARY_PORT:-$(read_port mlx primary || echo 8080)}"
  local mlx_sidecar_port="${PI_SIDECAR_PORT:-$(read_port mlx sidecar || echo 8081)}"
  local resolved_primary=""
  local resolved_primary_source=""
  IFS=$'\t' read -r resolved_primary resolved_primary_source < <(resolve_mlx_model_source "$MLX_PRIMARY_LOCAL" "$MLX_PRIMARY_REPO")
  MLX_PRIMARY_MODEL="$resolved_primary"
  MLX_PRIMARY_SOURCE="$resolved_primary_source"

  local resolved_sidecar=""
  local resolved_sidecar_source=""
  IFS=$'\t' read -r resolved_sidecar resolved_sidecar_source < <(resolve_mlx_model_source "$MLX_SIDECAR_LOCAL" "$MLX_SIDECAR_REPO")
  MLX_SIDECAR_MODEL="$resolved_sidecar"
  MLX_SIDECAR_SOURCE="$resolved_sidecar_source"

  # ── Start MLX PRIMARY server ──
  if is_running "$MLX_PRIMARY_PID"; then
    log "MLX primary server already running (PID $(get_pid "$MLX_PRIMARY_PID"))"
  else
    # Build KV cache quantization flags (if configured)
    local kv_flags=()
    if [[ -n "$MLX_KV_BITS" ]]; then
      kv_flags=(--kv-bits "$MLX_KV_BITS" --kv-group-size "$MLX_KV_GROUP_SIZE" --quantized-kv-start "$MLX_KV_START")
    fi

    log "Starting MLX primary server: $MLX_PRIMARY_MODEL"
    log "  Source: $MLX_PRIMARY_SOURCE"
    log "  Backend: MLX (Apple Silicon Metal) | Port: $mlx_primary_port"
    log "  Max tokens: $MLX_MAX_TOKENS | Decode concurrency: $MLX_DECODE_CONCURRENCY | Prompt concurrency: $MLX_PROMPT_CONCURRENCY"
    log "  Sampling (Unsloth precise coding): temp=$SAMPLING_TEMP top_p=$SAMPLING_TOP_P top_k=$SAMPLING_TOP_K"
    if [[ -n "$MLX_KV_BITS" ]]; then
      log "  KV cache: ${MLX_KV_BITS}-bit (group_size=$MLX_KV_GROUP_SIZE, start=$MLX_KV_START)"
    else
      log "  KV cache: FP16 (full precision)"
    fi
    log "  Chat template args: enable_thinking=true"

    if [[ ${#kv_flags[@]} -gt 0 ]]; then
      nohup "$MLX_PYTHON" "$MLX_WRAPPER" \
        "${kv_flags[@]}" \
        --model "$MLX_PRIMARY_MODEL" \
        --port "$mlx_primary_port" \
        --host "127.0.0.1" \
        --temp "$SAMPLING_TEMP" \
        --top-p "$SAMPLING_TOP_P" \
        --top-k "$SAMPLING_TOP_K" \
        --min-p "$SAMPLING_MIN_P" \
        --max-tokens "$MLX_MAX_TOKENS" \
        --decode-concurrency "$MLX_DECODE_CONCURRENCY" \
        --prompt-concurrency "$MLX_PROMPT_CONCURRENCY" \
        --trust-remote-code \
        --chat-template-args '{"enable_thinking":true}' \
        --log-level INFO \
        > "$MLX_PRIMARY_LOG" 2>&1 &
    else
      nohup "$MLX_PYTHON" "$MLX_WRAPPER" \
        --model "$MLX_PRIMARY_MODEL" \
        --port "$mlx_primary_port" \
        --host "127.0.0.1" \
        --temp "$SAMPLING_TEMP" \
        --top-p "$SAMPLING_TOP_P" \
        --top-k "$SAMPLING_TOP_K" \
        --min-p "$SAMPLING_MIN_P" \
        --max-tokens "$MLX_MAX_TOKENS" \
        --decode-concurrency "$MLX_DECODE_CONCURRENCY" \
        --prompt-concurrency "$MLX_PROMPT_CONCURRENCY" \
        --trust-remote-code \
        --chat-template-args '{"enable_thinking":true}' \
        --log-level INFO \
        > "$MLX_PRIMARY_LOG" 2>&1 &
    fi

    echo $! > "$MLX_PRIMARY_PID"
    log "MLX primary server launched (PID $(get_pid "$MLX_PRIMARY_PID"))"
  fi

  # ── Start MLX SIDECAR server ──
  if is_running "$MLX_SIDECAR_PID"; then
    log "MLX sidecar server already running (PID $(get_pid "$MLX_SIDECAR_PID"))"
  else
    log "Starting MLX sidecar server: $MLX_SIDECAR_MODEL"
    log "  Source: $MLX_SIDECAR_SOURCE"
    log "  Backend: MLX (Apple Silicon Metal) | Port: $mlx_sidecar_port"
    log "  Max tokens: $MLX_MAX_TOKENS | Decode concurrency: $MLX_DECODE_CONCURRENCY | Prompt concurrency: $MLX_PROMPT_CONCURRENCY"
    log "  Sampling (Unsloth precise coding): temp=$SAMPLING_TEMP top_p=$SAMPLING_TOP_P top_k=$SAMPLING_TOP_K"
    log "  KV cache: FP16 (sidecar uses shorter context)"
    log "  Chat template args: enable_thinking=true"

    nohup "$MLX_PYTHON" "$MLX_WRAPPER" \
      --model "$MLX_SIDECAR_MODEL" \
      --port "$mlx_sidecar_port" \
      --host "127.0.0.1" \
      --temp "$SAMPLING_TEMP" \
      --top-p "$SAMPLING_TOP_P" \
      --top-k "$SAMPLING_TOP_K" \
      --min-p "$SAMPLING_MIN_P" \
      --max-tokens "$MLX_MAX_TOKENS" \
      --decode-concurrency "$MLX_DECODE_CONCURRENCY" \
      --prompt-concurrency "$MLX_PROMPT_CONCURRENCY" \
      --trust-remote-code \
      --chat-template-args '{"enable_thinking":true}' \
      --log-level INFO \
      > "$MLX_SIDECAR_LOG" 2>&1 &

    echo $! > "$MLX_SIDECAR_PID"
    log "MLX sidecar server launched (PID $(get_pid "$MLX_SIDECAR_PID"))"
  fi

  # ── Health checks ──
  log ""
  log "Waiting for MLX servers to load models (first run downloads from HuggingFace)..."
  log "  Primary: ~29 GB ($MLX_PRIMARY_MODEL | source=$MLX_PRIMARY_SOURCE)"
  log "  Sidecar: ~5 GB ($MLX_SIDECAR_MODEL | source=$MLX_SIDECAR_SOURCE)"
  log ""

  local primary_ok=false sidecar_ok=false

  # MLX server uses /v1/models endpoint — check it returns valid JSON
  if wait_for_health_mlx "sidecar" "$mlx_sidecar_port" "$HEALTH_TIMEOUT"; then
    sidecar_ok=true
  fi

  if wait_for_health_mlx "primary" "$mlx_primary_port" "$HEALTH_TIMEOUT"; then
    primary_ok=true
  fi

  log ""
  log "┌─────────────────────────────────────────────┐"
  log "│       Pi Models Server Status (MLX)          │"
  log "├─────────────────────────────────────────────┤"
  if $primary_ok; then
    log "│  PRIMARY  ✓  :$mlx_primary_port  qwen3.5-35b-a3b (8-bit, $MLX_PRIMARY_SOURCE)"
  else
    log "│  PRIMARY  ✗  :$mlx_primary_port  (not ready)"
  fi
  if $sidecar_ok; then
    log "│  SIDECAR  ✓  :$mlx_sidecar_port  qwen3.5-9b (8-bit, $MLX_SIDECAR_SOURCE)"
  else
    log "│  SIDECAR  ✗  :$mlx_sidecar_port  (not ready)"
  fi
  log "├─────────────────────────────────────────────┤"
  log "│  Logs: $MODELS_DIR/mlx-*.log"
  log "│  Stop: pi-models.sh stop"
  log "└─────────────────────────────────────────────┘"

  if $primary_ok && $sidecar_ok; then
    return 0
  else
    warn "One or more servers not ready. Check logs."
    return 1
  fi
}

# ── llama-cpp start ────────────────────────────────────────────────────────────

cmd_start_llama() {
  local llama_primary_port="${PI_PRIMARY_PORT:-$(read_port llama-cpp primary || echo 8090)}"
  local llama_sidecar_port="${PI_SIDECAR_PORT:-$(read_port llama-cpp sidecar || echo 8091)}"

  # Check llama-server exists
  command -v "$LLAMA_SERVER" >/dev/null 2>&1 || die "llama-server not found. Install llama.cpp first."

  # ── Start PRIMARY server ──
  if is_running "$PRIMARY_PID"; then
    log "Primary server already running (PID $(get_pid "$PRIMARY_PID"))"
  else
    log "Starting primary server: $PRIMARY_HF"
    log "  Port: $llama_primary_port | Context: $PRIMARY_CTX | Slots: $PRIMARY_SLOTS"
    log "  GPU: all layers | Flash attn: $FLASH_ATTN | KV cache: $KV_CACHE_TYPE_K/$KV_CACHE_TYPE_V"
    log "  Batch: $BATCH_SIZE/$UBATCH_SIZE | Threads: $THREADS (gen) / $THREADS_BATCH (batch) | Poll: $POLL"
    log "  Priority: $PRIO (gen) / $PRIO_BATCH (batch) | No-warmup: on | No-mmproj: on | Metrics: on"
    log "  Sampling (Unsloth precise coding): temp=$SAMPLING_TEMP top_p=$SAMPLING_TOP_P top_k=$SAMPLING_TOP_K"

    nohup "$LLAMA_SERVER" \
      -hf "$PRIMARY_HF" \
      --no-mmproj \
      --ctx-size "$PRIMARY_CTX" \
      -ngl "$GPU_LAYERS" \
      -fa "$FLASH_ATTN" \
      -ctk "$KV_CACHE_TYPE_K" \
      -ctv "$KV_CACHE_TYPE_V" \
      -cb \
      -b "$BATCH_SIZE" \
      -ub "$UBATCH_SIZE" \
      -t "$THREADS" \
      -tb "$THREADS_BATCH" \
      -np "$PRIMARY_SLOTS" \
      --poll "$POLL" \
      --prio "$PRIO" \
      --prio-batch "$PRIO_BATCH" \
      --mlock \
      --no-warmup \
      --metrics \
      --cache-reuse "$CACHE_REUSE" \
      --temp "$SAMPLING_TEMP" \
      --top-p "$SAMPLING_TOP_P" \
      --top-k "$SAMPLING_TOP_K" \
      --min-p "$SAMPLING_MIN_P" \
      --presence-penalty "$SAMPLING_PRESENCE_PENALTY" \
      --jinja \
      --port "$llama_primary_port" \
      --alias "$PRIMARY_ALIAS" \
      --slot-save-path "$PRIMARY_SLOT_SAVE" \
      --log-file "$PRIMARY_LOG" \
      > /dev/null 2>&1 &

    echo $! > "$PRIMARY_PID"
    log "Primary server launched (PID $(get_pid "$PRIMARY_PID"))"
  fi

  # ── Start SIDECAR server ──
  if is_running "$SIDECAR_PID"; then
    log "Sidecar server already running (PID $(get_pid "$SIDECAR_PID"))"
  else
    log "Starting sidecar server: $SIDECAR_HF"
    log "  Port: $llama_sidecar_port | Context: $SIDECAR_CTX | Slots: $SIDECAR_SLOTS"
    log "  GPU: all layers | Flash attn: $FLASH_ATTN | KV cache: $KV_CACHE_TYPE_K/$KV_CACHE_TYPE_V"
    log "  Batch: $BATCH_SIZE/$UBATCH_SIZE | Threads: $THREADS (gen) / $THREADS_BATCH (batch) | Poll: $POLL"
    log "  Priority: $PRIO (gen) / $PRIO_BATCH (batch) | No-warmup: on | Metrics: on"
    log "  Sampling (Unsloth precise coding): temp=$SAMPLING_TEMP top_p=$SAMPLING_TOP_P top_k=$SAMPLING_TOP_K"

    nohup "$LLAMA_SERVER" \
      -hf "$SIDECAR_HF" \
      --no-mmproj \
      --ctx-size "$SIDECAR_CTX" \
      -ngl "$GPU_LAYERS" \
      -fa "$FLASH_ATTN" \
      -ctk "$KV_CACHE_TYPE_K" \
      -ctv "$KV_CACHE_TYPE_V" \
      -cb \
      -b "$BATCH_SIZE" \
      -ub "$UBATCH_SIZE" \
      -t "$THREADS" \
      -tb "$THREADS_BATCH" \
      -np "$SIDECAR_SLOTS" \
      --poll "$POLL" \
      --prio "$PRIO" \
      --prio-batch "$PRIO_BATCH" \
      --mlock \
      --no-warmup \
      --metrics \
      --cache-reuse "$CACHE_REUSE" \
      --temp "$SAMPLING_TEMP" \
      --top-p "$SAMPLING_TOP_P" \
      --top-k "$SAMPLING_TOP_K" \
      --min-p "$SAMPLING_MIN_P" \
      --presence-penalty "$SAMPLING_PRESENCE_PENALTY" \
      --port "$llama_sidecar_port" \
      --alias "$SIDECAR_ALIAS" \
      --slot-save-path "$SIDECAR_SLOT_SAVE" \
      --log-file "$SIDECAR_LOG" \
      > /dev/null 2>&1 &

    echo $! > "$SIDECAR_PID"
    log "Sidecar server launched (PID $(get_pid "$SIDECAR_PID"))"
  fi

  # ── Health checks ──
  log ""
  log "Waiting for servers to load models (first run downloads from HuggingFace)..."
  log "  Primary: ~45 GB (35B-A3B UD-Q8_K_XL)"
  log "  Sidecar: ~12 GB (9B UD-Q8_K_XL)"
  log ""

  local primary_ok=false sidecar_ok=false

  # Check sidecar first (smaller, loads faster)
  if wait_for_health "sidecar" "$llama_sidecar_port" "$HEALTH_TIMEOUT"; then
    sidecar_ok=true
  fi

  if wait_for_health "primary" "$llama_primary_port" "$HEALTH_TIMEOUT"; then
    primary_ok=true
  fi

  log ""
  log "┌─────────────────────────────────────────────┐"
  log "│     Pi Models Server Status (llama-cpp)      │"
  log "├─────────────────────────────────────────────┤"
  if $primary_ok; then
    log "│  PRIMARY  ✓  :$llama_primary_port  $PRIMARY_ALIAS"
  else
    log "│  PRIMARY  ✗  :$llama_primary_port  (not ready)"
  fi
  if $sidecar_ok; then
    log "│  SIDECAR  ✓  :$llama_sidecar_port  $SIDECAR_ALIAS"
  else
    log "│  SIDECAR  ✗  :$llama_sidecar_port  (not ready)"
  fi
  log "├─────────────────────────────────────────────┤"
  log "│  Logs: $MODELS_DIR/llama-*.log"
  log "│  Stop: pi-models.sh stop"
  log "└─────────────────────────────────────────────┘"

  if $primary_ok && $sidecar_ok; then
    return 0
  else
    warn "One or more servers not ready. Check logs."
    return 1
  fi
}

cmd_stop() {
  # Stop all server types (llama-cpp and MLX)
  stop_server "llama-cpp primary" "$PRIMARY_PID"
  stop_server "llama-cpp sidecar" "$SIDECAR_PID"
  stop_server "MLX primary" "$MLX_PRIMARY_PID"
  stop_server "MLX sidecar" "$MLX_SIDECAR_PID"
  log "All servers stopped"
}

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start "${1:-}"
}

cmd_status() {
  log "Server status:"
  log ""

  local resolved_primary=""
  local resolved_primary_source=""
  IFS=$'\t' read -r resolved_primary resolved_primary_source < <(resolve_mlx_model_source "$MLX_PRIMARY_LOCAL" "$MLX_PRIMARY_REPO")
  local resolved_sidecar=""
  local resolved_sidecar_source=""
  IFS=$'\t' read -r resolved_sidecar resolved_sidecar_source < <(resolve_mlx_model_source "$MLX_SIDECAR_LOCAL" "$MLX_SIDECAR_REPO")

  local any_running=false

  # ── llama-cpp servers ──
  if is_running "$PRIMARY_PID"; then
    any_running=true
    local pid
    pid=$(get_pid "$PRIMARY_PID")
    local llama_primary_port="${PI_PRIMARY_PORT:-$(read_port llama-cpp primary || echo 8090)}"
    local health
    health=$(curl -sf "http://localhost:${llama_primary_port}/health" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','?'))" 2>/dev/null || echo "unreachable")
    log "  LLAMA PRIMARY  PID=$pid  port=$llama_primary_port  health=$health"

    local slots_info
    slots_info=$(curl -sf "http://localhost:${llama_primary_port}/slots" 2>/dev/null | python3 -c "
import sys, json
slots = json.load(sys.stdin)
busy = sum(1 for s in slots if s.get('is_processing', False))
total = len(slots)
print(f'{busy}/{total} slots busy')
" 2>/dev/null || echo "slots: unknown")
    log "                 $slots_info"
  fi

  if is_running "$SIDECAR_PID"; then
    any_running=true
    local pid
    pid=$(get_pid "$SIDECAR_PID")
    local llama_sidecar_port="${PI_SIDECAR_PORT:-$(read_port llama-cpp sidecar || echo 8091)}"
    local health
    health=$(curl -sf "http://localhost:${llama_sidecar_port}/health" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','?'))" 2>/dev/null || echo "unreachable")
    log "  LLAMA SIDECAR  PID=$pid  port=$llama_sidecar_port  health=$health"

    local slots_info
    slots_info=$(curl -sf "http://localhost:${llama_sidecar_port}/slots" 2>/dev/null | python3 -c "
import sys, json
slots = json.load(sys.stdin)
busy = sum(1 for s in slots if s.get('is_processing', False))
total = len(slots)
print(f'{busy}/{total} slots busy')
" 2>/dev/null || echo "slots: unknown")
    log "                 $slots_info"
  fi

  # ── MLX servers ──
  if is_running "$MLX_PRIMARY_PID"; then
    any_running=true
    local pid
    pid=$(get_pid "$MLX_PRIMARY_PID")
    local mlx_primary_port="${PI_PRIMARY_PORT:-$(read_port mlx primary || echo 8080)}"
    local health
    health=$(curl -sf "http://localhost:${mlx_primary_port}/v1/models" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print('ok' if 'data' in d else '?')" 2>/dev/null || echo "unreachable")
    log "  MLX PRIMARY    PID=$pid  port=$mlx_primary_port  health=$health  source=$resolved_primary_source"
  fi

  if is_running "$MLX_SIDECAR_PID"; then
    any_running=true
    local pid
    pid=$(get_pid "$MLX_SIDECAR_PID")
    local mlx_sidecar_port="${PI_SIDECAR_PORT:-$(read_port mlx sidecar || echo 8081)}"
    local health
    health=$(curl -sf "http://localhost:${mlx_sidecar_port}/v1/models" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print('ok' if 'data' in d else '?')" 2>/dev/null || echo "unreachable")
    log "  MLX SIDECAR    PID=$pid  port=$mlx_sidecar_port  health=$health  source=$resolved_sidecar_source"
  fi

  if ! $any_running; then
    log "  No servers running"
  fi
}

cmd_logs() {
  local target="${1:-all}"
  case "$target" in
    primary)
      # Try MLX first, then llama-cpp
      if [[ -f "$MLX_PRIMARY_LOG" ]] && is_running "$MLX_PRIMARY_PID"; then
        tail -f "$MLX_PRIMARY_LOG"
      elif [[ -f "$PRIMARY_LOG" ]]; then
        tail -f "$PRIMARY_LOG"
      else
        die "No primary log file found"
      fi
      ;;
    sidecar)
      if [[ -f "$MLX_SIDECAR_LOG" ]] && is_running "$MLX_SIDECAR_PID"; then
        tail -f "$MLX_SIDECAR_LOG"
      elif [[ -f "$SIDECAR_LOG" ]]; then
        tail -f "$SIDECAR_LOG"
      else
        die "No sidecar log file found"
      fi
      ;;
    all)
      # Tail all existing log files
      local logs=()
      for f in "$MLX_PRIMARY_LOG" "$MLX_SIDECAR_LOG" "$PRIMARY_LOG" "$SIDECAR_LOG"; do
        [[ -f "$f" ]] && logs+=("$f")
      done
      if (( ${#logs[@]} == 0 )); then
        die "No log files found"
      fi
      tail -f "${logs[@]}"
      ;;
    *)
      die "Unknown log target: $target (use primary|sidecar|all)"
      ;;
  esac
}

# ── Main ───────────────────────────────────────────────────────────────────────

case "${1:-}" in
  start)      cmd_start "${2:-}" ;;
  stop)       cmd_stop ;;
  restart)    cmd_restart "${2:-}" ;;
  status)     cmd_status ;;
  logs)       cmd_logs "${2:-all}" ;;
  sync-ports) sync_ports ;;
  *)
    echo "Usage: $(basename "$0") {start [mlx|llama-cpp]|stop|restart|status|logs [primary|sidecar|all]|sync-ports}"
    exit 1
    ;;
esac
