/**
 * model-backend.ts — Shared model-state provider abstraction.
 *
 * Probes MLX (localhost:8090), llama-cpp (localhost:8080), LM Studio
 * (localhost:1234), and LlamaBarn (localhost:2276) to detect which backend
 * is running and retrieve model state / loaded context info.
 *
 * Auto-detection: probes all four in parallel, uses first responder.
 * Override: PI_MODEL_BACKEND=mlx | llama-cpp | lmstudio | llamabarn | auto (default: auto).
 *
 * Also provides sidecar model configuration: reads the `sidecar` section from
 * models.json and returns per-role model IDs for the active provider.
 *
 * Consumed by:
 *   - runtime-trace.ts  (doctor command)
 *   - hybrid-optimizer.ts  (optimizer, oracle, RLM extractor)
 *   - compaction-guard.ts  (compaction model)
 *   - health-watchdog.ts  (verifier model)
 *   - research-orchestrator.ts  (critic model)
 */

import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BackendName = "lmstudio" | "llamabarn" | "llama-cpp" | "mlx" | "unknown";

export interface ModelInfo {
  /** Which backend answered */
  backend: BackendName;
  /** Model state as reported by the backend */
  state: string;
  /** Loaded context length (tokens), null if unknown/not-loaded */
  loadedContextLength: number | null;
  /** Max context length the model supports (from backend metadata) */
  maxContextLength: number | null;
}

export interface BackendStatus {
  /** Which backend was detected / used */
  backend: BackendName;
  /** Whether the backend responded at all */
  reachable: boolean;
}

/**
 * Sidecar model role mapping — one per provider in models.json `sidecar` section.
 * Each key maps a functional role to a model ID registered in that provider.
 */
export interface SidecarConfig {
  /** Provider name to use for sidecar model lookups (may differ from primary) */
  _sidecarProvider?: string;
  optimizer: string;
  optimizerFallback: string;
  researchOptimizer: string;
  oracle: string;
  rlmExtractor: string;
  compaction: string;
  verifier: string;
  critic: string;
}

// ---------------------------------------------------------------------------
// Configuration (env)
// ---------------------------------------------------------------------------

const BACKEND_PREFERENCE = parseBackendPref(process.env.PI_MODEL_BACKEND);

const LMSTUDIO_MODELS_URL =
  process.env.PI_LMSTUDIO_MODELS_URL || "http://localhost:1234/api/v0/models";
const LLAMABARN_MODELS_URL =
  process.env.PI_LLAMABARN_MODELS_URL || "http://localhost:2276/v1/models";
const LLAMACPP_PRIMARY_HEALTH_URL =
  process.env.PI_LLAMACPP_PRIMARY_HEALTH_URL || "http://localhost:8080/health";
const LLAMACPP_SIDECAR_HEALTH_URL =
  process.env.PI_LLAMACPP_SIDECAR_HEALTH_URL || "http://localhost:8081/health";
const LLAMACPP_PRIMARY_SLOTS_URL =
  process.env.PI_LLAMACPP_PRIMARY_SLOTS_URL || "http://localhost:8080/slots";
const MLX_PRIMARY_HEALTH_URL =
  process.env.PI_MLX_PRIMARY_HEALTH_URL || "http://localhost:8090/health";
const MLX_PRIMARY_MODELS_URL =
  process.env.PI_MLX_PRIMARY_MODELS_URL || "http://localhost:8090/v1/models";
const PROBE_TIMEOUT_MS = parsePositiveInt(process.env.PI_MODEL_BACKEND_TIMEOUT_MS, 2500);

// ---------------------------------------------------------------------------
// Sidecar config (from models.json `sidecar` section)
// ---------------------------------------------------------------------------

const MODELS_JSON_PATH = path.join(homedir(), ".pi", "agent", "models.json");

/** Default sidecar model IDs when `sidecar` section is absent or missing a provider. */
const DEFAULT_SIDECAR: SidecarConfig = {
  optimizer: "qwen3.5-9b",
  optimizerFallback: "unsloth/qwen3.5-27b",
  researchOptimizer: "qwen3.5-9b",
  oracle: "",                    // empty → falls back to primary model
  rlmExtractor: "qwen3.5-9b",
  compaction: "qwen3.5-9b",
  verifier: "",                  // empty → falls back to primary model
  critic: "",                    // empty → falls back to primary model
};

let _sidecarCache: Record<string, SidecarConfig> | null = null;
let _sidecarCacheMtime = 0;

function readSidecarMap(): Record<string, SidecarConfig> {
  try {
    const stat = fs.statSync(MODELS_JSON_PATH);
    const mtime = stat.mtimeMs;
    if (_sidecarCache && mtime === _sidecarCacheMtime) return _sidecarCache;

    const raw = fs.readFileSync(MODELS_JSON_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    const sidecar = parsed?.sidecar;
    if (!sidecar || typeof sidecar !== "object") {
      _sidecarCache = {};
      _sidecarCacheMtime = mtime;
      return _sidecarCache;
    }
    const result: Record<string, SidecarConfig> = {};
    for (const [providerName, cfg] of Object.entries(sidecar)) {
      if (!cfg || typeof cfg !== "object") continue;
      const c = cfg as Record<string, unknown>;
      result[providerName] = {
        _sidecarProvider:  typeof c._sidecarProvider === "string" ? c._sidecarProvider : undefined,
        optimizer:         typeof c.optimizer === "string"         ? c.optimizer         : DEFAULT_SIDECAR.optimizer,
        optimizerFallback: typeof c.optimizerFallback === "string" ? c.optimizerFallback : DEFAULT_SIDECAR.optimizerFallback,
        researchOptimizer: typeof c.researchOptimizer === "string" ? c.researchOptimizer : DEFAULT_SIDECAR.researchOptimizer,
        oracle:            typeof c.oracle === "string"            ? c.oracle            : DEFAULT_SIDECAR.oracle,
        rlmExtractor:      typeof c.rlmExtractor === "string"      ? c.rlmExtractor      : DEFAULT_SIDECAR.rlmExtractor,
        compaction:        typeof c.compaction === "string"        ? c.compaction        : DEFAULT_SIDECAR.compaction,
        verifier:          typeof c.verifier === "string"          ? c.verifier          : DEFAULT_SIDECAR.verifier,
        critic:            typeof c.critic === "string"            ? c.critic            : DEFAULT_SIDECAR.critic,
      };
    }
    _sidecarCache = result;
    _sidecarCacheMtime = mtime;
    return result;
  } catch {
    return {};
  }
}

/**
 * Get sidecar model configuration for the given provider.
 *
 * Falls back to the DEFAULT_SIDECAR (LM Studio hardcoded defaults) if the
 * provider has no entry in models.json `sidecar` section.
 */
export function getSidecarConfig(provider: string): SidecarConfig {
  const map = readSidecarMap();
  return map[provider] || { ...DEFAULT_SIDECAR };
}

/**
 * Resolve the provider name to use for sidecar model registry lookups.
 *
 * For most backends (lmstudio, llamabarn) this returns the same provider.
 * For llama-cpp, the primary model lives on port 8080 ("llama-cpp") but
 * sidecar models live on port 8081 ("llama-cpp-sidecar"). The
 * `_sidecarProvider` field in the sidecar config handles this redirect.
 */
export function resolveSidecarProvider(provider: string): string {
  const sc = getSidecarConfig(provider);
  return sc._sidecarProvider || provider;
}

/**
 * Resolve the active provider name from extension context.
 *
 * Priority:
 *   1. PI_SIDECAR_PROVIDER env var (global override)
 *   2. ctx.model?.provider (the provider of the active session model)
 *   3. "lmstudio" (safe fallback)
 */
export function resolveActiveProvider(ctx: { model?: { provider?: string } }): string {
  const envOverride = (process.env.PI_SIDECAR_PROVIDER || "").trim();
  if (envOverride) return envOverride;
  const ctxProvider = typeof ctx.model?.provider === "string" ? ctx.model.provider.trim() : "";
  if (ctxProvider) return ctxProvider;
  return "lmstudio";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parseBackendPref(value: string | undefined): "lmstudio" | "llamabarn" | "llama-cpp" | "mlx" | "auto" {
  const v = (value || "").trim().toLowerCase();
  if (v === "lmstudio" || v === "lms") return "lmstudio";
  if (v === "llamabarn" || v === "barn") return "llamabarn";
  if (v === "llama-cpp" || v === "llamacpp" || v === "lcpp") return "llama-cpp";
  if (v === "mlx") return "mlx";
  return "auto";
}

/**
 * Match a model ID that may include a publisher prefix (e.g. "unsloth/qwen3.5-35b-a3b")
 * against a backend's model ID that may omit the prefix (e.g. "qwen3.5-35b-a3b").
 *
 * Also checks the backend's publisher field for LM Studio entries.
 */
function modelIdMatches(
  wantedId: string,
  entry: { id?: string; publisher?: string }
): boolean {
  if (!wantedId || !entry.id) return false;
  const entryId = String(entry.id).trim();
  const wanted = wantedId.trim();

  // Exact match
  if (entryId === wanted) return true;

  // wanted = "publisher/name", entry.id = "name" (LM Studio style)
  const slashIdx = wanted.indexOf("/");
  if (slashIdx > 0) {
    const wantedPublisher = wanted.slice(0, slashIdx);
    const wantedName = wanted.slice(slashIdx + 1);
    if (entryId === wantedName) {
      // If the entry has a publisher field, verify it matches
      if (entry.publisher) {
        return String(entry.publisher).trim().toLowerCase() === wantedPublisher.toLowerCase();
      }
      // No publisher field — accept the name match
      return true;
    }
  }

  // entry.id = "publisher/name", wanted = "name" (reverse case)
  const entrySlash = entryId.indexOf("/");
  if (entrySlash > 0) {
    const entryName = entryId.slice(entrySlash + 1);
    if (entryName === wanted) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// LM Studio provider
// ---------------------------------------------------------------------------

interface LmsModelRow {
  id: string;
  publisher?: string;
  state?: string;
  loaded_context_length?: number;
  max_context_length?: number;
}

async function probeLmStudio(
  modelId: string,
  timeoutMs: number
): Promise<ModelInfo | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(LMSTUDIO_MODELS_URL, { signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const rows: LmsModelRow[] = Array.isArray(data?.data) ? data.data : [];
    const row = rows.find((r) => modelIdMatches(modelId, r));
    if (!row) {
      return {
        backend: "lmstudio",
        state: "not-found",
        loadedContextLength: null,
        maxContextLength: null,
      };
    }
    const loaded = Number(row.loaded_context_length);
    const maxCtx = Number(row.max_context_length);
    return {
      backend: "lmstudio",
      state: String(row.state || "unknown"),
      loadedContextLength: Number.isFinite(loaded) && loaded > 0 ? Math.floor(loaded) : null,
      maxContextLength: Number.isFinite(maxCtx) && maxCtx > 0 ? Math.floor(maxCtx) : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// LlamaBarn provider
// ---------------------------------------------------------------------------

interface BarnModelRow {
  id: string;
  status?: { value?: string; args?: string[]; preset?: string };
}

function extractCtxSizeFromArgs(args: string[]): number | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ctx-size" && i + 1 < args.length) {
      const val = Number(args[i + 1]);
      if (Number.isFinite(val) && val > 0) return Math.floor(val);
    }
  }
  return null;
}

async function probeLlamaBarn(
  modelId: string,
  timeoutMs: number
): Promise<ModelInfo | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(LLAMABARN_MODELS_URL, { signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const rows: BarnModelRow[] = Array.isArray(data?.data) ? data.data : [];

    // LlamaBarn uses short aliases (e.g. "devstral-2-24b") so try fuzzy matching
    const row = rows.find((r) => modelIdMatches(modelId, r));
    if (!row) {
      return {
        backend: "llamabarn",
        state: "not-found",
        loadedContextLength: null,
        maxContextLength: null,
      };
    }

    const statusValue = row.status?.value || "unknown";
    // LlamaBarn doesn't expose loaded_context_length — parse from args
    const ctxFromArgs = Array.isArray(row.status?.args)
      ? extractCtxSizeFromArgs(row.status!.args!)
      : null;

    return {
      backend: "llamabarn",
      state: statusValue,
      loadedContextLength: statusValue === "loaded" ? ctxFromArgs : null,
      maxContextLength: ctxFromArgs,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Reachability check (for auto-detection without a model ID)
// ---------------------------------------------------------------------------

async function isReachable(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// llama-cpp provider (raw llama-server on localhost:8080/8081)
// ---------------------------------------------------------------------------

/**
 * Probe a llama-server instance via its /health endpoint.
 * llama-server /health returns: { "status": "ok" | "loading model" | "error" }
 * llama-server /slots returns per-slot info including context size.
 */
async function probeLlamaCpp(
  modelId: string,
  timeoutMs: number
): Promise<ModelInfo | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Hit /health first
    const healthRes = await fetch(LLAMACPP_PRIMARY_HEALTH_URL, { signal: controller.signal });
    if (!healthRes.ok) return null;
    const healthData = (await healthRes.json()) as any;
    const status = String(healthData?.status || "unknown");

    // Map llama-server status to our state convention
    const state = status === "ok" ? "loaded" : status === "loading model" ? "loading" : status;

    // Try to get context size from /slots
    let loadedCtx: number | null = null;
    try {
      const slotsRes = await fetch(LLAMACPP_PRIMARY_SLOTS_URL, { signal: controller.signal });
      if (slotsRes.ok) {
        const slots = (await slotsRes.json()) as any[];
        if (Array.isArray(slots) && slots.length > 0) {
          const ctx = Number(slots[0]?.n_ctx);
          if (Number.isFinite(ctx) && ctx > 0) loadedCtx = ctx;
        }
      }
    } catch { /* slots endpoint optional */ }

    return {
      backend: "llama-cpp",
      state,
      loadedContextLength: state === "loaded" ? loadedCtx : null,
      maxContextLength: loadedCtx,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// MLX provider (mlx_lm.server on localhost:8090)
// ---------------------------------------------------------------------------

/**
 * Probe an mlx_lm.server instance via /health and /v1/models.
 *
 * mlx_lm.server /health returns: { "status": "ok" }
 * mlx_lm.server /v1/models returns a list of loaded model IDs.
 *
 * Unlike llama-cpp, MLX has no /slots endpoint and doesn't report context
 * size via API. We return null for loadedContextLength — the context window
 * from models.json will be used instead (no mismatch warning).
 */
async function probeMlx(
  modelId: string,
  timeoutMs: number
): Promise<ModelInfo | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Hit /health first
    const healthRes = await fetch(MLX_PRIMARY_HEALTH_URL, { signal: controller.signal });
    if (!healthRes.ok) return null;
    const healthData = (await healthRes.json()) as any;
    const status = String(healthData?.status || "unknown");
    if (status !== "ok") {
      return {
        backend: "mlx",
        state: status,
        loadedContextLength: null,
        maxContextLength: null,
      };
    }

    // Check /v1/models for the requested model
    let modelFound = false;
    try {
      const modelsRes = await fetch(MLX_PRIMARY_MODELS_URL, { signal: controller.signal });
      if (modelsRes.ok) {
        const data = (await modelsRes.json()) as any;
        const rows: Array<{ id?: string }> = Array.isArray(data?.data) ? data.data : [];
        // MLX model IDs are like "mlx-community/Qwen3.5-35B-A3B-4bit"
        // Our model IDs are like "qwen3.5-35b-a3b"
        // Use case-insensitive substring matching on the model name portion
        modelFound = rows.some((r) => mlxModelIdMatches(modelId, String(r.id || "")));
      }
    } catch { /* models endpoint query optional */ }

    return {
      backend: "mlx",
      state: modelFound ? "loaded" : "not-found",
      // MLX doesn't expose context size via API — return null
      // so the doctor command won't emit a context mismatch warning
      loadedContextLength: null,
      maxContextLength: null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fuzzy-match a models.json model ID against an MLX server model ID.
 *
 * MLX server returns IDs like "mlx-community/Qwen3.5-35B-A3B-4bit"
 * models.json has IDs like "qwen3.5-35b-a3b"
 *
 * Strategy: strip quantization suffix from MLX ID, compare base names
 * case-insensitively.
 */
function mlxModelIdMatches(wantedId: string, mlxId: string): boolean {
  if (!wantedId || !mlxId) return false;

  const wanted = wantedId.trim().toLowerCase();
  const mlx = mlxId.trim().toLowerCase();

  // Exact match
  if (wanted === mlx) return true;

  // Extract the base model name from MLX ID:
  // "mlx-community/qwen3.5-35b-a3b-4bit" → "qwen3.5-35b-a3b-4bit"
  const mlxSlash = mlx.lastIndexOf("/");
  const mlxName = mlxSlash >= 0 ? mlx.slice(mlxSlash + 1) : mlx;

  // Strip common quantization suffixes: -4bit, -8bit, -3bit, etc.
  const mlxBase = mlxName.replace(/-\d+bit$/, "");

  // Extract the base model name from wanted ID (may have publisher prefix)
  const wantedSlash = wanted.lastIndexOf("/");
  const wantedName = wantedSlash >= 0 ? wanted.slice(wantedSlash + 1) : wanted;

  return wantedName === mlxBase || wantedName === mlxName;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch model info from whichever backend is available.
 *
 * Resolution order:
 *   1. If PI_MODEL_BACKEND is set, only probe that backend.
 *   2. Otherwise probe all four in parallel; return the first to respond
 *      with a loaded model.  Priority on tie: mlx > llama-cpp > lmstudio > llamabarn.
 */
export async function fetchModelInfo(modelId: string): Promise<ModelInfo> {
  const fallback: ModelInfo = {
    backend: "unknown",
    state: "unavailable",
    loadedContextLength: null,
    maxContextLength: null,
  };
  if (!modelId) return fallback;

  if (BACKEND_PREFERENCE === "lmstudio") {
    return (await probeLmStudio(modelId, PROBE_TIMEOUT_MS)) ?? fallback;
  }
  if (BACKEND_PREFERENCE === "llamabarn") {
    return (await probeLlamaBarn(modelId, PROBE_TIMEOUT_MS)) ?? fallback;
  }
  if (BACKEND_PREFERENCE === "llama-cpp") {
    return (await probeLlamaCpp(modelId, PROBE_TIMEOUT_MS)) ?? fallback;
  }
  if (BACKEND_PREFERENCE === "mlx") {
    return (await probeMlx(modelId, PROBE_TIMEOUT_MS)) ?? fallback;
  }

  // auto: probe all in parallel
  const [mlx, lcpp, lms, barn] = await Promise.all([
    probeMlx(modelId, PROBE_TIMEOUT_MS),
    probeLlamaCpp(modelId, PROBE_TIMEOUT_MS),
    probeLmStudio(modelId, PROBE_TIMEOUT_MS),
    probeLlamaBarn(modelId, PROBE_TIMEOUT_MS),
  ]);

  // Prefer whichever found the model in a loaded state (mlx first, then llama-cpp)
  if (mlx && mlx.state === "loaded") return mlx;
  if (lcpp && lcpp.state === "loaded") return lcpp;
  if (lms && lms.state === "loaded") return lms;
  if (barn && barn.state === "loaded") return barn;
  // Then prefer whichever responded at all
  if (mlx) return mlx;
  if (lcpp) return lcpp;
  if (lms) return lms;
  if (barn) return barn;

  return fallback;
}

/**
 * Convenience: fetch just the loaded context window (tokens).
 * Drop-in replacement for the old `fetchLoadedContextWindow` in hybrid-optimizer.
 */
export async function fetchLoadedContextWindow(modelId: string): Promise<number | null> {
  if (!modelId) return null;
  const info = await fetchModelInfo(modelId);
  return info.loadedContextLength;
}

/**
 * Detect which backend(s) are reachable (for diagnostic display).
 */
export async function detectBackends(): Promise<BackendStatus[]> {
  const [mlx, lcpp, lms, barn] = await Promise.all([
    isReachable(MLX_PRIMARY_HEALTH_URL, PROBE_TIMEOUT_MS),
    isReachable(LLAMACPP_PRIMARY_HEALTH_URL, PROBE_TIMEOUT_MS),
    isReachable(LMSTUDIO_MODELS_URL, PROBE_TIMEOUT_MS),
    isReachable(LLAMABARN_MODELS_URL, PROBE_TIMEOUT_MS),
  ]);
  const results: BackendStatus[] = [];
  results.push({ backend: "mlx", reachable: mlx });
  results.push({ backend: "llama-cpp", reachable: lcpp });
  results.push({ backend: "lmstudio", reachable: lms });
  results.push({ backend: "llamabarn", reachable: barn });
  return results;
}

/**
 * Fetch model info from ALL reachable backends (for /doctor multi-backend view).
 */
export async function fetchModelInfoAll(modelId: string): Promise<ModelInfo[]> {
  if (!modelId) return [];
  const [mlx, lcpp, lms, barn] = await Promise.all([
    probeMlx(modelId, PROBE_TIMEOUT_MS),
    probeLlamaCpp(modelId, PROBE_TIMEOUT_MS),
    probeLmStudio(modelId, PROBE_TIMEOUT_MS),
    probeLlamaBarn(modelId, PROBE_TIMEOUT_MS),
  ]);
  const results: ModelInfo[] = [];
  if (mlx) results.push(mlx);
  if (lcpp) results.push(lcpp);
  if (lms) results.push(lms);
  if (barn) results.push(barn);
  return results;
}

// ---------------------------------------------------------------------------
// Response text extraction with thinking-block fallback
// ---------------------------------------------------------------------------

/**
 * Extract usable text from a Pi model response's content blocks.
 *
 * With `enable_thinking: true`, Qwen3.5 models sometimes put ALL output into
 * the reasoning/thinking field and leave the `content` (text) field empty.
 * The Pi SDK maps reasoning to `{type: "thinking", thinking: "..."}` blocks
 * and normal output to `{type: "text", text: "..."}` blocks.
 *
 * This helper:
 *   1. Joins all `type === "text"` blocks.
 *   2. If that yields empty/too-short text, falls back to `type === "thinking"` blocks.
 *   3. Strips `<think>...</think>` wrappers from thinking content.
 *
 * Returns `{ text, source }` where source is "text" | "thinking" | "empty".
 */
export function extractResponseText(
  response: { content?: any[] } | any,
  minLength: number = 10,
): { text: string; source: "text" | "thinking" | "empty" } {
  const content: any[] = response?.content ?? [];

  // 1) Normal path: join all text-type blocks
  const textContent = content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text ?? "")
    .join("\n")
    .trim();

  if (textContent && textContent.length >= minLength) {
    return { text: textContent, source: "text" };
  }

  // 2) Thinking fallback: join all thinking-type blocks
  const thinkingRaw = content
    .filter((c: any) => c.type === "thinking")
    .map((c: any) => c.thinking || c.text || "")
    .join("\n")
    .trim();

  if (!thinkingRaw || thinkingRaw.length < minLength) {
    return { text: textContent || thinkingRaw || "", source: "empty" };
  }

  // Strip <think>…</think> wrappers (both greedy blocks and lone tags)
  const stripped =
    thinkingRaw
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .trim() ||
    thinkingRaw.replace(/<\/?think>/gi, "").trim();

  if (stripped && stripped.length >= minLength) {
    return { text: stripped, source: "thinking" };
  }

  // If stripping removed too much, return the raw thinking content
  return { text: thinkingRaw, source: "thinking" };
}

// No-op default export so Pi's extension loader doesn't reject this utility module.
// All real functionality is accessed via named exports (fetchModelInfo, resolveSidecarProvider, etc.).
export default function modelBackendExtension(_pi: any): void {
  // Utility-only module — nothing to register.
}
