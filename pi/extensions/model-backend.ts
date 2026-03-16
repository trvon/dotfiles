/**
 * model-backend.ts — Shared model-state provider abstraction.
 *
 * Probes MLX (127.0.0.1:8080), llama-cpp (127.0.0.1:8090), and
 * LlamaBarn (127.0.0.1:2276) to detect which backend is running and
 * retrieve model state / loaded context info.
 *
 * Auto-detection: probes all three in parallel, uses first responder.
 * Override: PI_MODEL_BACKEND=mlx | llama-cpp | llamabarn | auto (default: auto).
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

export type BackendName = "llamabarn" | "llama-cpp" | "mlx" | "unknown";

export interface ModelInfo {
  /** Which backend answered */
  backend: BackendName;
  /** Model state as reported by the backend */
  state: string;
  /** Loaded context length (tokens), null if unknown/not-loaded */
  loadedContextLength: number | null;
  /** Max context length the model supports (from backend metadata) */
  maxContextLength: number | null;
  /** Backend-reported model identifier/path when available */
  resolvedModelId?: string | null;
}

export interface ModelCapabilities {
  provider: string;
  modelId: string;
  modelName: string | null;
  contextWindow: number | null;
  maxTokens: number | null;
  reasoning: boolean;
  reasoningFormat: string | null;
  maxTokensField: string | null;
  supportsStore: boolean | null;
  supportsDeveloperRole: boolean | null;
  supportsReasoningEffort: boolean | null;
  parserProfile: "qwen-thinking" | "openai-completions" | "generic";
  toolFidelityTier: "high" | "medium" | "low";
  notes: string[];
}

export interface ResponseNormalization {
  text: string;
  source: "text" | "thinking" | "mixed" | "empty";
  hasPseudoToolMarkup: boolean;
  jsonCandidate: string | null;
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

const LLAMABARN_MODELS_URL =
  process.env.PI_LLAMABARN_MODELS_URL || "http://127.0.0.1:2276/v1/models";
const LLAMACPP_PRIMARY_HEALTH_URL =
  process.env.PI_LLAMACPP_PRIMARY_HEALTH_URL || "http://127.0.0.1:8090/health";
const LLAMACPP_SIDECAR_HEALTH_URL =
  process.env.PI_LLAMACPP_SIDECAR_HEALTH_URL || "http://127.0.0.1:8091/health";
const LLAMACPP_PRIMARY_SLOTS_URL =
  process.env.PI_LLAMACPP_PRIMARY_SLOTS_URL || "http://127.0.0.1:8090/slots";
const MLX_PRIMARY_HEALTH_URL =
  process.env.PI_MLX_PRIMARY_HEALTH_URL || "http://127.0.0.1:8080/health";
const MLX_PRIMARY_MODELS_URL =
  process.env.PI_MLX_PRIMARY_MODELS_URL || "http://127.0.0.1:8080/v1/models";
const PROBE_TIMEOUT_MS = parsePositiveInt(process.env.PI_MODEL_BACKEND_TIMEOUT_MS, 2500);

// ---------------------------------------------------------------------------
// Sidecar config (from models.json `sidecar` section)
// ---------------------------------------------------------------------------

const MODELS_JSON_PATH = path.join(homedir(), ".pi", "agent", "models.json");
const SETTINGS_JSON_PATH = path.join(homedir(), ".pi", "agent", "settings.json");
const PROVIDER_TRACE_FILE = path.join(homedir(), ".pi", "agent", "provider-resolution.jsonl");
const PROVIDER_TRACE_ENABLED = (process.env.PI_PROVIDER_TRACE ?? "1") !== "0";

/** Append a one-line JSON trace to the provider resolution log. */
function providerTrace(event: string, data: Record<string, unknown>): void {
  if (!PROVIDER_TRACE_ENABLED) return;
  try {
    const line = JSON.stringify({ t: Date.now(), event, ...data }) + "\n";
    fs.appendFileSync(PROVIDER_TRACE_FILE, line);
  } catch { /* best-effort */ }
}

let _modelsJsonCache: any | null = null;
let _modelsJsonCacheMtime = 0;

function readModelsJsonDoc(): any {
  try {
    const stat = fs.statSync(MODELS_JSON_PATH);
    const mtime = stat.mtimeMs;
    if (_modelsJsonCache && mtime === _modelsJsonCacheMtime) return _modelsJsonCache;
    const raw = fs.readFileSync(MODELS_JSON_PATH, "utf-8");
    _modelsJsonCache = JSON.parse(raw);
    _modelsJsonCacheMtime = mtime;
    return _modelsJsonCache;
  } catch {
    return null;
  }
}

let _settingsJsonCache: any | null = null;
let _settingsJsonCacheMtime = 0;

/**
 * Read `defaultProvider` from settings.json (mtime-cached).
 * Returns the provider string or "" if unavailable.
 */
function readDefaultProvider(): string {
  try {
    const stat = fs.statSync(SETTINGS_JSON_PATH);
    const mtime = stat.mtimeMs;
    if (!_settingsJsonCache || mtime !== _settingsJsonCacheMtime) {
      const raw = fs.readFileSync(SETTINGS_JSON_PATH, "utf-8");
      _settingsJsonCache = JSON.parse(raw);
      _settingsJsonCacheMtime = mtime;
    }
    const dp = _settingsJsonCache?.defaultProvider;
    return typeof dp === "string" ? dp.trim() : "";
  } catch {
    return "";
  }
}

/**
 * Default sidecar model IDs when `sidecar` section is absent or missing a
 * provider.  Uses generic model IDs that match the llama-cpp sidecar config
 * (the expected default backend).
 */
const DEFAULT_SIDECAR: SidecarConfig = {
  optimizer: "qwen3.5-9b",
  optimizerFallback: "qwen3.5-9b",
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

    const parsed = readModelsJsonDoc();
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
 * Falls back to DEFAULT_SIDECAR (generic qwen3.5-9b defaults) if the
 * provider has no entry in models.json `sidecar` section.
 */
export function getSidecarConfig(provider: string): SidecarConfig {
  const map = readSidecarMap();
  return map[provider] || { ...DEFAULT_SIDECAR };
}

/**
 * Resolve the provider name to use for sidecar model registry lookups.
 *
 * For most backends (llamabarn) this returns the same provider.
 * For llama-cpp, the primary model lives on port 8090 ("llama-cpp") but
 * sidecar models live on port 8091 ("llama-cpp-sidecar"). The
 * `_sidecarProvider` field in the sidecar config handles this redirect.
 */
export function resolveSidecarProvider(provider: string): string {
  const sc = getSidecarConfig(provider);
  return sc._sidecarProvider || provider;
}

/**
 * Resolve the active provider name for sidecar routing.
 *
 * Priority:
 *   1. PI_SIDECAR_PROVIDER env var (global override)
 *   2. settings.json defaultProvider (single source of truth)
 *   3. ctx.model?.provider (session model's provider — last resort only)
 *   4. "mlx" (hardcoded fallback, should never be reached)
 *
 * NOTE: settings.json beats ctx.model.provider because ctx.model.provider
 * reflects the *conversation* model's provider, NOT which backend should
 * serve the sidecar/optimizer.  settings.json.defaultProvider is what the
 * user explicitly configured as the active infrastructure backend.
 */
export function resolveActiveProvider(ctx: { model?: { provider?: string } }): string {
  const envOverride = (process.env.PI_SIDECAR_PROVIDER || "").trim();
  if (envOverride) {
    providerTrace("resolveActiveProvider", { source: "env", value: envOverride });
    return envOverride;
  }
  const settingsProvider = readDefaultProvider();
  if (settingsProvider) {
    providerTrace("resolveActiveProvider", { source: "settings.json", value: settingsProvider });
    return settingsProvider;
  }
  const ctxProvider = typeof ctx.model?.provider === "string" ? ctx.model.provider.trim() : "";
  if (ctxProvider) {
    providerTrace("resolveActiveProvider", { source: "ctx.model.provider", value: ctxProvider });
    return ctxProvider;
  }
  providerTrace("resolveActiveProvider", { source: "hardcoded_fallback", value: "mlx" });
  return "mlx";
}

function getProviderModelRecord(provider: string, modelId: string): Record<string, any> | null {
  const parsed = readModelsJsonDoc();
  const providers = parsed?.providers;
  if (!providers || typeof providers !== "object") return null;
  const p = providers[provider];
  if (!p || typeof p !== "object") return null;
  const models = Array.isArray((p as any).models) ? (p as any).models : [];
  for (const model of models) {
    if (!model || typeof model !== "object") continue;
    const id = typeof (model as any).id === "string" ? (model as any).id.trim() : "";
    if (id && modelIdMatches(modelId, { id })) return model as Record<string, any>;
  }
  return null;
}

function parseNullableBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

export function getModelCapabilities(provider: string, modelId: string): ModelCapabilities | null {
  if (!provider || !modelId) return null;
  const model = getProviderModelRecord(provider, modelId);
  if (!model) return null;

  const compat = (model.compat && typeof model.compat === "object") ? model.compat as Record<string, unknown> : {};
  const reasoning = Boolean(model.reasoning);
  const reasoningFormat = typeof compat.thinkingFormat === "string" ? compat.thinkingFormat : null;

  let parserProfile: ModelCapabilities["parserProfile"] = "generic";
  if (reasoning && reasoningFormat === "qwen") parserProfile = "qwen-thinking";
  else if (typeof model.api === "string" && model.api.includes("openai")) parserProfile = "openai-completions";

  let toolFidelityTier: ModelCapabilities["toolFidelityTier"] = "medium";
  const notes: string[] = [];
  if (parserProfile === "qwen-thinking") {
    toolFidelityTier = "medium";
    notes.push("qwen thinking blocks may require text/thinking fallback parsing");
  }
  if (!reasoning) {
    toolFidelityTier = "high";
    notes.push("non-thinking output typically improves structured tool/JSON adherence");
  }
  if (typeof model.id === "string" && model.id.includes("gpt-oss")) {
    toolFidelityTier = "high";
    notes.push("gpt-oss harmony-style models generally provide strong tool schema adherence");
  }
  if (typeof model.id === "string" && model.id.includes("thinking")) {
    notes.push("thinking-enabled model may spend budget before final answer");
  }

  return {
    provider,
    modelId: String(model.id || modelId),
    modelName: typeof model.name === "string" ? model.name : null,
    contextWindow: Number.isFinite(Number(model.contextWindow)) ? Math.floor(Number(model.contextWindow)) : null,
    maxTokens: Number.isFinite(Number(model.maxTokens)) ? Math.floor(Number(model.maxTokens)) : null,
    reasoning,
    reasoningFormat,
    maxTokensField: typeof compat.maxTokensField === "string" ? compat.maxTokensField : null,
    supportsStore: parseNullableBool(compat.supportsStore),
    supportsDeveloperRole: parseNullableBool(compat.supportsDeveloperRole),
    supportsReasoningEffort: parseNullableBool(compat.supportsReasoningEffort),
    parserProfile,
    toolFidelityTier,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parseBackendPref(value: string | undefined): "llamabarn" | "llama-cpp" | "mlx" | "auto" {
  const v = (value || "").trim().toLowerCase();
  if (v === "llamabarn" || v === "barn") return "llamabarn";
  if (v === "llama-cpp" || v === "llamacpp" || v === "lcpp") return "llama-cpp";
  if (v === "mlx") return "mlx";
  return "auto";
}

/**
 * Match a model ID that may include a publisher prefix (e.g. "unsloth/qwen3.5-35b-a3b")
 * against a backend's model ID that may omit the prefix (e.g. "qwen3.5-35b-a3b").
 *
 * Also checks the backend's publisher field if present.
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

  // wanted = "publisher/name", entry.id = "name"
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
        resolvedModelId: null,
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
      resolvedModelId: typeof row.id === "string" ? row.id : null,
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
// llama-cpp provider (raw llama-server on 127.0.0.1:8090/8091)
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
      resolvedModelId: modelId || null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// MLX provider (mlx_lm.server on 127.0.0.1:8080)
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
        resolvedModelId: null,
      };
    }

    // Check /v1/models for the requested model
    let modelFound = false;
    let resolvedModelId: string | null = null;
    try {
      const modelsRes = await fetch(MLX_PRIMARY_MODELS_URL, { signal: controller.signal });
      if (modelsRes.ok) {
        const data = (await modelsRes.json()) as any;
        const rows: Array<{ id?: string }> = Array.isArray(data?.data) ? data.data : [];
        // MLX model IDs are like "mlx-community/Qwen3.5-35B-A3B-4bit"
        // Our model IDs are like "qwen3.5-35b-a3b"
        // Use case-insensitive substring matching on the model name portion
        for (const row of rows) {
          const candidate = String(row.id || "");
          if (mlxModelIdMatches(modelId, candidate)) {
            modelFound = true;
            resolvedModelId = candidate;
            break;
          }
        }
        if (!resolvedModelId && rows.length > 0 && typeof rows[0]?.id === "string") {
          resolvedModelId = String(rows[0].id);
        }
      }
    } catch { /* models endpoint query optional */ }

    return {
      backend: "mlx",
      state: modelFound ? "loaded" : "not-found",
      // MLX doesn't expose context size via API — return null
      // so the doctor command won't emit a context mismatch warning
      loadedContextLength: null,
      maxContextLength: null,
      resolvedModelId,
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

export function inferModelSource(modelInfo: ModelInfo): "local-path" | "repo-or-cache" | "unknown" {
  const raw = typeof modelInfo?.resolvedModelId === "string" ? modelInfo.resolvedModelId.trim() : "";
  if (!raw) return "unknown";
  if (raw.startsWith("/")) return "local-path";
  if (raw.includes("/") || raw.includes("--")) return "repo-or-cache";
  return "unknown";
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
 *      with a loaded model.  Priority on tie: mlx > llama-cpp > llamabarn.
 */
export async function fetchModelInfo(modelId: string): Promise<ModelInfo> {
  const fallback: ModelInfo = {
    backend: "unknown",
    state: "unavailable",
    loadedContextLength: null,
    maxContextLength: null,
    resolvedModelId: null,
  };
  if (!modelId) return fallback;

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
  const [mlx, lcpp, barn] = await Promise.all([
    probeMlx(modelId, PROBE_TIMEOUT_MS),
    probeLlamaCpp(modelId, PROBE_TIMEOUT_MS),
    probeLlamaBarn(modelId, PROBE_TIMEOUT_MS),
  ]);

  // Prefer whichever found the model in a loaded state (mlx first, then llama-cpp)
  if (mlx && mlx.state === "loaded") return mlx;
  if (lcpp && lcpp.state === "loaded") return lcpp;
  if (barn && barn.state === "loaded") return barn;
  // Then prefer whichever responded at all
  if (mlx) return mlx;
  if (lcpp) return lcpp;
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
  const [mlx, lcpp, barn] = await Promise.all([
    isReachable(MLX_PRIMARY_HEALTH_URL, PROBE_TIMEOUT_MS),
    isReachable(LLAMACPP_PRIMARY_HEALTH_URL, PROBE_TIMEOUT_MS),
    isReachable(LLAMABARN_MODELS_URL, PROBE_TIMEOUT_MS),
  ]);
  const results: BackendStatus[] = [];
  results.push({ backend: "mlx", reachable: mlx });
  results.push({ backend: "llama-cpp", reachable: lcpp });
  results.push({ backend: "llamabarn", reachable: barn });
  return results;
}

/**
 * Fetch model info from ALL reachable backends (for /doctor multi-backend view).
 */
export async function fetchModelInfoAll(modelId: string): Promise<ModelInfo[]> {
  if (!modelId) return [];
  const [mlx, lcpp, barn] = await Promise.all([
    probeMlx(modelId, PROBE_TIMEOUT_MS),
    probeLlamaCpp(modelId, PROBE_TIMEOUT_MS),
    probeLlamaBarn(modelId, PROBE_TIMEOUT_MS),
  ]);
  const results: ModelInfo[] = [];
  if (mlx) results.push(mlx);
  if (lcpp) results.push(lcpp);
  if (barn) results.push(barn);
  return results;
}

// ---------------------------------------------------------------------------
// Response text extraction with thinking-block fallback
// ---------------------------------------------------------------------------

export function containsPseudoToolCallMarkup(text: string): boolean {
  const normalized = String(text || "").toLowerCase();
  if (!normalized) return false;
  const markers = [
    "<tool_call>",
    "</tool_call>",
    "<function=",
    "<function>",
    "<parameter=",
    "</function>",
    "</parameter>",
    "<tool>",
    "</tool>",
  ];
  return markers.some((m) => normalized.includes(m));
}

export function stripThinkingTags(text: string): string {
  const input = String(text || "");
  const stripped = input.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (stripped) return stripped;
  return input.replace(/<\/?think>/gi, "").trim();
}

export function stripMarkdownCodeFences(text: string): string {
  const input = String(text || "").trim();
  if (!input) return "";
  return input.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

export function extractFirstJsonObjectCandidate(text: string): string | null {
  const input = String(text || "");
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (ch === "}") {
      if (depth > 0) depth -= 1;
      if (depth === 0 && start >= 0) {
        return input.slice(start, i + 1);
      }
    }
  }

  return null;
}

export function normalizeResponseText(
  response: { content?: any[] } | any,
  minLength: number = 10,
): ResponseNormalization {
  const content: any[] = response?.content ?? [];

  const textContent = content
    .filter((c: any) => c?.type === "text")
    .map((c: any) => c?.text ?? "")
    .join("\n")
    .trim();

  const thinkingRaw = content
    .filter((c: any) => c?.type === "thinking")
    .map((c: any) => c?.thinking || c?.text || "")
    .join("\n")
    .trim();

  const thinkingContent = stripThinkingTags(thinkingRaw);

  let chosen = "";
  let source: ResponseNormalization["source"] = "empty";

  if (textContent && textContent.length >= minLength) {
    chosen = textContent;
    source = "text";
  }

  if ((!chosen || chosen.length < minLength) && thinkingContent && thinkingContent.length >= minLength) {
    chosen = thinkingContent;
    source = "thinking";
  }

  if (textContent && textContent.length >= minLength && thinkingContent && thinkingContent.length >= minLength) {
    source = "mixed";
  }

  const cleaned = stripMarkdownCodeFences(chosen);
  const jsonCandidate = extractFirstJsonObjectCandidate(cleaned);
  const hasPseudoToolMarkup = containsPseudoToolCallMarkup(chosen);

  return {
    text: cleaned || chosen || textContent || thinkingContent || "",
    source,
    hasPseudoToolMarkup,
    jsonCandidate,
  };
}

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
  const normalized = normalizeResponseText(response, minLength);
  if (normalized.source === "thinking") return { text: normalized.text, source: "thinking" };
  if (normalized.source === "text" || normalized.source === "mixed") return { text: normalized.text, source: "text" };
  return { text: normalized.text, source: "empty" };
}

// No-op default export so Pi's extension loader doesn't reject this utility module.
// All real functionality is accessed via named exports (fetchModelInfo, resolveSidecarProvider, etc.).
export default function modelBackendExtension(_pi: any): void {
  // Utility-only module — nothing to register.
}
