import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { stream } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { contextChunker } from "./semantic-compressor.ts";
import { extractResponseText, fetchLoadedContextWindow, getSidecarConfig, resolveActiveProvider, resolveSidecarProvider } from "./model-backend.ts";
import type { SidecarConfig } from "./model-backend.ts";

type Mode = "fast" | "deep";
type OptimizationProfile = "general" | "research";

type OptimizerState = {
  objective: string;
  carry: string[];
  memoryHints: Array<{ path: string; snippet: string; score: number }>;
  lastOriginalPrompt: string;
  lastOptimizedPrompt: string;
  lastMode: Mode;
  lastProfile: OptimizationProfile;
  lastOptimizationSource: "model" | "fallback";
  updatedAt: number;
  optimizerModel: string;
  optimizations: number;
  optimizerAttempts: number;
  optimizerSuccesses: number;
  optimizerFallbacks: number;
  failures: number;
};

type OptimizerResult = {
  mode: Mode;
  optimizedPrompt: string;
  executionBrief: string;
  objective: string;
  carry: string[];
  confidence: number;
};

type OracleReview = {
  verdict: "pass" | "warn" | "fail";
  confidence: number;
  issues: string[];
  requiredChecks: string[];
};

type ContextSteering = {
  contextWindow: number;
  usageTokens: number;
  availableTokens: number;
  usageRatio: number;
  pressure: "low" | "medium" | "high" | "critical";
};

const ENV_PRIMARY_MODEL = (process.env.PI_PRIMARY_MODEL || "").trim();
const ENV_OPTIMIZER_PROVIDER = (process.env.PI_OPTIMIZER_PROVIDER || "").trim();
const ENV_OPTIMIZER_MODEL = (process.env.PI_OPTIMIZER_MODEL || "").trim();
const ENV_FALLBACK_OPTIMIZER_MODEL = (process.env.PI_OPTIMIZER_FALLBACK_MODEL || "").trim();
const ENV_RESEARCH_OPTIMIZER_MODEL = (process.env.PI_OPTIMIZER_RESEARCH_MODEL || "").trim();
const ORACLE_ENABLED = parseBoolean(process.env.PI_ORACLE_ENABLED, true);
const ENV_ORACLE_PROVIDER = (process.env.PI_ORACLE_PROVIDER || "").trim();
const ORACLE_MODEL = (process.env.PI_ORACLE_MODEL || ENV_PRIMARY_MODEL).trim();
const ORACLE_MAX_TOKENS = parsePositiveInt(process.env.PI_ORACLE_MAX_TOKENS, 160);
const ORACLE_INACTIVITY_MS = parsePositiveInt(process.env.PI_ORACLE_INACTIVITY_MS, 45000);

const MIN_PROMPT_CHARS_FOR_OPTIMIZER = parsePositiveInt(process.env.PI_OPTIMIZER_MIN_CHARS, 120);
const OPTIMIZER_MAX_TOKENS = parsePositiveInt(process.env.PI_OPTIMIZER_MAX_TOKENS, 700);
const OPTIMIZER_INACTIVITY_MS = parsePositiveInt(process.env.PI_OPTIMIZER_INACTIVITY_MS, 20000);
const UI_PROGRESS_NOTIFY_MS = parsePositiveInt(process.env.PI_HYBRID_UI_PROGRESS_NOTIFY_MS, 1500);
const AUTO_THINKING = parseBoolean(process.env.PI_HYBRID_AUTO_THINKING, true);
const YAMS_ENABLED = parseBoolean(process.env.PI_HYBRID_YAMS_ENABLED, true);
const PROFILE_EMBED_ROUTER = parseBoolean(process.env.PI_HYBRID_PROFILE_EMBED_ROUTER, true);
const YAMS_LIMIT = parsePositiveInt(process.env.PI_HYBRID_YAMS_LIMIT, 4);
const YAMS_TIMEOUT_MS = parsePositiveInt(process.env.PI_HYBRID_YAMS_TIMEOUT_MS, 12000);
const ALLOW_LOOSE_PARSE = parseBoolean(process.env.PI_HYBRID_ALLOW_LOOSE_PARSE, false);
const FORWARD_OPTIMIZED_MESSAGE = parseBoolean(process.env.PI_HYBRID_FORWARD_OPTIMIZED_MESSAGE, true);
const FORWARD_PROMPT_MAX_CHARS = parsePositiveInt(process.env.PI_HYBRID_FORWARD_PROMPT_MAX_CHARS, 1200);
const SHOW_PROMPT_PAIR = parseBoolean(process.env.PI_HYBRID_SHOW_PROMPT_PAIR, true);
const PROMPT_PREVIEW_CHARS = parsePositiveInt(process.env.PI_HYBRID_PROMPT_PREVIEW_CHARS, 700);
const PROMPT_STATE_CHARS = parsePositiveInt(process.env.PI_HYBRID_PROMPT_STATE_CHARS, 2400);
const TRACE_FILE = process.env.PI_HYBRID_TRACE_FILE || `${homedir()}/.pi/agent/hybrid-optimizer.jsonl`;

const COMPACTION_RATIO = parseRatio(process.env.PI_HYBRID_COMPACTION_RATIO, 0.75);
let COMPACTION_MIN_TOKENS = parsePositiveInt(process.env.PI_HYBRID_COMPACTION_MIN_TOKENS, 128000);
const COMPACTION_COOLDOWN_MS = parsePositiveInt(process.env.PI_HYBRID_COMPACTION_COOLDOWN_MS, 180000);
const COMPACTION_SAFETY_HEADROOM_TOKENS = parsePositiveInt(
  process.env.PI_HYBRID_COMPACTION_SAFETY_HEADROOM,
  16384
);
const MAX_BRIEF_CHARS = 2200;
const MAX_CARRY_ITEMS = 6;
const MAX_HINTS_IN_PROMPT = 3;
const MAX_HINT_SNIPPET_CHARS = 220;
const KEEP_RECENT_ASSISTANT_MESSAGES = parsePositiveInt(process.env.PI_HYBRID_KEEP_RECENT_ASSISTANT, 6);
const CAP_OLD_ASSISTANT_TEXT_CHARS = parsePositiveInt(process.env.PI_HYBRID_CAP_OLD_ASSISTANT_TEXT, 1800);

// --- RLM (Retrieval-augmented Long Memory) ---
const RLM_ENABLED = parseBoolean(process.env.PI_RLM_ENABLED, true);
const RLM_COLLECTION = process.env.PI_RLM_COLLECTION || "pi-session-memory";
const RLM_STORE_TAGS = "rlm,pi-session-memory";
const RLM_MAX_CHUNKS_PER_COMPACTION = parsePositiveInt(process.env.PI_RLM_MAX_CHUNKS, 5);
const RLM_MAX_CHUNK_CHARS = parsePositiveInt(process.env.PI_RLM_MAX_CHUNK_CHARS, 2000);
const RLM_RETRIEVE_LIMIT = parsePositiveInt(process.env.PI_RLM_RETRIEVE_LIMIT, 3);
const RLM_RETRIEVE_TIMEOUT_MS = parsePositiveInt(process.env.PI_RLM_RETRIEVE_TIMEOUT_MS, 8000);
const RLM_STORE_TIMEOUT_MS = parsePositiveInt(process.env.PI_RLM_STORE_TIMEOUT_MS, 10000);
const RLM_MIN_SCORE = 0.003;
const RLM_SEARCH_SIMILARITY = process.env.PI_RLM_SEARCH_SIMILARITY || "0.001";
const RLM_MAX_HINTS_IN_PROMPT = 3;
const RLM_MAX_HINT_SNIPPET_CHARS = 400;

// RLM extractor mode: "heuristic" (default) or "model" (uses sidecar LLM)
const RLM_EXTRACTOR_MODE = (process.env.PI_RLM_EXTRACTOR_MODE || "heuristic") as "heuristic" | "model";
const ENV_RLM_EXTRACTOR_PROVIDER = (process.env.PI_RLM_EXTRACTOR_PROVIDER || "").trim();
const ENV_RLM_EXTRACTOR_MODEL = (process.env.PI_RLM_EXTRACTOR_MODEL || "").trim();
const RLM_EXTRACTOR_MAX_TOKENS = parsePositiveInt(process.env.PI_RLM_EXTRACTOR_MAX_TOKENS, 1200);
const RLM_EXTRACTOR_INACTIVITY_MS = parsePositiveInt(process.env.PI_RLM_EXTRACTOR_INACTIVITY_MS, 20000);
const RLM_EXTRACTOR_MAX_INPUT_CHARS = parsePositiveInt(process.env.PI_RLM_EXTRACTOR_MAX_INPUT_CHARS, 12000);

// --- DCS integration for RLM ---
const RLM_DCS_SESSION_ENRICHMENT = parseBoolean(process.env.PI_RLM_DCS_SESSION_ENRICHMENT, false);
const RLM_DCS_SESSION_TIMEOUT_MS = parsePositiveInt(process.env.PI_RLM_DCS_SESSION_TIMEOUT_MS, 60_000);
const RLM_DEEP_RECALL_TIMEOUT_MS = parsePositiveInt(process.env.PI_RLM_DEEP_RECALL_TIMEOUT_MS, 120_000);
const DCS_CLI = process.env.PI_RLM_DCS_CLI || "research-agent";

const execFileAsync = promisify(execFile);

// --- Context flooding protection ---
const TOOL_OUTPUT_MAX_CHARS = parsePositiveInt(process.env.PI_TOOL_OUTPUT_MAX_CHARS, 8000);
const TOOL_OUTPUT_HEAD_CHARS = parsePositiveInt(process.env.PI_TOOL_OUTPUT_HEAD_CHARS, 7000);
const TOOL_OUTPUT_TAIL_CHARS = parsePositiveInt(process.env.PI_TOOL_OUTPUT_TAIL_CHARS, 500);
// Compaction polling: instead of a fixed timeout that races with actual work,
// we poll periodically to log progress and only declare a true stall after
// prolonged inactivity.  The callbacks (onComplete/onError) are the sole
// authority for clearing `compactionInFlight`.
const COMPACTION_POLL_INTERVAL_MS = parsePositiveInt(process.env.PI_COMPACTION_POLL_INTERVAL_MS, 10_000);
const COMPACTION_STALL_THRESHOLD_MS = parsePositiveInt(process.env.PI_COMPACTION_STALL_THRESHOLD_MS, 300_000); // 5 min hard stall
let CONTEXT_BUDGET_WARN_TOKENS = parsePositiveInt(process.env.PI_CONTEXT_BUDGET_WARN_TOKENS, 200000);
let CONTEXT_BUDGET_STEER_TOKENS = parsePositiveInt(process.env.PI_CONTEXT_BUDGET_STEER_TOKENS, 80000);

// --- Token-aware context management tiers ---
let CTX_TIER1_TOKENS = parsePositiveInt(process.env.PI_CTX_TIER1_TOKENS, 64000);
let CTX_TIER2_TOKENS = parsePositiveInt(process.env.PI_CTX_TIER2_TOKENS, 128000);
let CTX_TIER3_TOKENS = parsePositiveInt(process.env.PI_CTX_TIER3_TOKENS, 192000);
// Tier 1 tighter caps
const TIER1_TOOL_OUTPUT_MAX_CHARS = parsePositiveInt(process.env.PI_TIER1_TOOL_OUTPUT_MAX_CHARS, 4000);
const TIER1_CAP_OLD_ASSISTANT_TEXT_CHARS = parsePositiveInt(process.env.PI_TIER1_CAP_OLD_ASSISTANT_TEXT, 600);
const TIER1_KEEP_RECENT_ASSISTANT_MESSAGES = parsePositiveInt(process.env.PI_TIER1_KEEP_RECENT_ASSISTANT, 4);
// Tier 2: YAMS chunk retrieval integration (keepLastN for buildOptimizedContext)
const TIER2_SEMANTIC_KEEP_LAST_N = parsePositiveInt(process.env.PI_TIER2_SEMANTIC_KEEP_LAST_N, 30);
// Tier 3: emergency — keep only the last N messages verbatim
const TIER3_KEEP_LAST_MESSAGES = parsePositiveInt(process.env.PI_TIER3_KEEP_LAST_MESSAGES, 8);
const YAMS_FIRST_STEERING = `IMPORTANT: To avoid context flooding, always use YAMS (yams search) FIRST for content discovery. Use the YAMS search results to identify relevant files, then read only the specific files or line ranges you need. Do NOT use broad directory listings (find, ls -R), do NOT cat entire files. Steps: 1) yams search for relevant content, 2) read specific files/sections identified by YAMS, 3) grep only if YAMS returns no results for a specific pattern.`;

type RlmChunk = {
  type: "objective" | "user-request" | "assistant-finding" | "file-context";
  content: string;
};

type RlmMemoryHint = {
  snippet: string;
  score: number;
  chunkType: string;
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function parseRatio(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) return fallback;
  return parsed;
}

// --- Adaptive threshold scaling ---
// Default thresholds are calibrated for a 262k context window.
// This function rescales any thresholds not explicitly set via env vars
// to maintain the same proportional positions for smaller/larger windows.
const REFERENCE_CONTEXT_WINDOW = 262144;
function scaleContextThresholds(contextWindow: number): void {
  if (!contextWindow || contextWindow <= 0 || contextWindow === REFERENCE_CONTEXT_WINDOW) return;
  const scale = contextWindow / REFERENCE_CONTEXT_WINDOW;
  if (!process.env.PI_HYBRID_COMPACTION_MIN_TOKENS) {
    COMPACTION_MIN_TOKENS = Math.max(4096, Math.floor(128000 * scale));
  }
  if (!process.env.PI_CONTEXT_BUDGET_WARN_TOKENS) {
    CONTEXT_BUDGET_WARN_TOKENS = Math.max(4096, Math.floor(200000 * scale));
  }
  if (!process.env.PI_CONTEXT_BUDGET_STEER_TOKENS) {
    CONTEXT_BUDGET_STEER_TOKENS = Math.max(2048, Math.floor(80000 * scale));
  }
  if (!process.env.PI_CTX_TIER1_TOKENS) {
    CTX_TIER1_TOKENS = Math.max(2048, Math.floor(64000 * scale));
  }
  if (!process.env.PI_CTX_TIER2_TOKENS) {
    CTX_TIER2_TOKENS = Math.max(4096, Math.floor(128000 * scale));
  }
  if (!process.env.PI_CTX_TIER3_TOKENS) {
    CTX_TIER3_TOKENS = Math.max(8192, Math.floor(192000 * scale));
  }
  trace("context_thresholds_scaled", {
    contextWindow,
    scale: Number(scale.toFixed(4)),
    compactionMinTokens: COMPACTION_MIN_TOKENS,
    budgetWarn: CONTEXT_BUDGET_WARN_TOKENS,
    budgetSteer: CONTEXT_BUDGET_STEER_TOKENS,
    tier1: CTX_TIER1_TOKENS,
    tier2: CTX_TIER2_TOKENS,
    tier3: CTX_TIER3_TOKENS,
  });
}

function classifyContextPressure(ratio: number): ContextSteering["pressure"] {
  if (ratio >= 0.93) return "critical";
  if (ratio >= 0.82) return "high";
  if (ratio >= 0.65) return "medium";
  return "low";
}

function buildContextSteering(
  usageTokens: number | null | undefined,
  configuredContextWindow: number,
  effectiveContextWindow: number | null
): ContextSteering | null {
  if (usageTokens === null || usageTokens === undefined || !Number.isFinite(usageTokens) || usageTokens < 0) return null;
  const contextWindow =
    effectiveContextWindow && Number.isFinite(effectiveContextWindow) && effectiveContextWindow > 0
      ? effectiveContextWindow
      : configuredContextWindow;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null;

  const usage = Math.max(0, Math.floor(usageTokens));
  const available = Math.max(0, Math.floor(contextWindow - usage));
  const ratio = Math.max(0, Math.min(1, usage / contextWindow));
  return {
    contextWindow,
    usageTokens: usage,
    availableTokens: available,
    usageRatio: ratio,
    pressure: classifyContextPressure(ratio),
  };
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  if (!ctx.hasUI) return;
  ctx.ui.notify(message, type);
}

function trace(type: string, payload: Record<string, unknown> = {}): void {
  if (!TRACE_FILE) return;
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), type, ...payload });
    fs.appendFileSync(TRACE_FILE, `${line}\n`, "utf-8");
  } catch {
    // Ignore trace write failures.
  }
}

function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const chunks: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      chunks.push(block);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    if (typeof block.text === "string") chunks.push(block.text);
    if (typeof block.thinking === "string") chunks.push(block.thinking);
    if (typeof block.content === "string") chunks.push(block.content);
  }
  return chunks.join("\n");
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

// ---------------------------------------------------------------------------
// Deferred temp file cleanup — prevents race with async YAMS ingest
// ---------------------------------------------------------------------------

/** How long to keep temp files before sweeping (15 min). */
const DEFERRED_TTL_MS = 15 * 60 * 1000;
/** Maximum number of pending temp files before forced eviction. */
const DEFERRED_MAX_FILES = 200;

type DeferredFile = { path: string; createdAt: number };

/**
 * Manages deferred cleanup of temp files written for YAMS ingest.
 *
 * `yams add` is async — it enqueues a document and returns immediately.
 * The daemon's IngestService processes the queue later and reads the file
 * from disk. If we `unlinkSync` the temp file in a `finally` block right
 * after `exec("yams", ["add", ...])` returns, the daemon may find the file
 * already deleted.
 *
 * Instead, temp files are registered here and cleaned up:
 * - Periodically (files older than DEFERRED_TTL_MS) via `sweep()`
 * - On session_shutdown via `flushAll()`
 * - When the pending count exceeds DEFERRED_MAX_FILES (oldest evicted)
 */
class TempFileManager {
  private _pending: DeferredFile[] = [];

  /** Register a temp file for deferred cleanup. */
  register(filePath: string, now?: number): void {
    this._pending.push({ path: filePath, createdAt: now ?? Date.now() });
    // If we exceed the bound, evict oldest files immediately
    while (this._pending.length > DEFERRED_MAX_FILES) {
      const oldest = this._pending.shift()!;
      try {
        fs.unlinkSync(oldest.path);
      } catch {
        // Already gone or inaccessible — fine.
      }
    }
  }

  /** Sweep files older than TTL. Returns count of files removed. */
  sweep(now?: number): number {
    const cutoff = (now ?? Date.now()) - DEFERRED_TTL_MS;
    let removed = 0;
    const remaining: DeferredFile[] = [];

    for (const entry of this._pending) {
      if (entry.createdAt < cutoff) {
        try {
          fs.unlinkSync(entry.path);
        } catch {
          // Already gone — fine.
        }
        removed++;
      } else {
        remaining.push(entry);
      }
    }

    this._pending = remaining;
    return removed;
  }

  /** Flush all pending files (called on session_shutdown). */
  flushAll(): number {
    let removed = 0;
    for (const entry of this._pending) {
      try {
        fs.unlinkSync(entry.path);
        removed++;
      } catch {
        // Already gone — fine.
      }
    }
    this._pending = [];
    return removed;
  }

  get pendingCount(): number {
    return this._pending.length;
  }
}

/** Module-level temp file manager for the hybrid optimizer's RLM chunks. */
const rlmTempFileManager = new TempFileManager();

function truncateToolOutput(text: string): { text: string; truncated: boolean; originalLength: number } {
  if (text.length <= TOOL_OUTPUT_MAX_CHARS) return { text, truncated: false, originalLength: text.length };
  const head = text.slice(0, TOOL_OUTPUT_HEAD_CHARS);
  const tail = text.slice(-TOOL_OUTPUT_TAIL_CHARS);
  const marker = `\n\n--- [TRUNCATED: ${text.length.toLocaleString()} chars -> ${(head.length + tail.length + 100).toLocaleString()} chars. Use targeted reads or YAMS search for full content.] ---\n\n`;
  return { text: head + marker + tail, truncated: true, originalLength: text.length };
}

function normalizeLines(lines: string[]): string[] {
  return lines
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
}

function resolvePrimaryModelId(ctx: ExtensionContext): string {
  const preferred = normalizeLines([ctx.model?.id || "", ENV_PRIMARY_MODEL]);
  return preferred[0] || "";
}

function normalizeHintList(input: Array<{ path: string; snippet: string; score: number }>): Array<{
  path: string;
  snippet: string;
  score: number;
}> {
  return input
    .map((hint) => ({
      path: typeof hint.path === "string" ? hint.path.trim() : "",
      snippet: typeof hint.snippet === "string" ? hint.snippet.replace(/\s+/g, " ").trim() : "",
      score: typeof hint.score === "number" && Number.isFinite(hint.score) ? hint.score : 0,
    }))
    .filter((hint) => hint.path.length > 0 && hint.snippet.length > 0)
    .slice(0, Math.max(1, YAMS_LIMIT));
}

function needsDeepMode(prompt: string): boolean {
  const deepSignals = [
    "architecture",
    "tradeoff",
    "design",
    "refactor",
    "migration",
    "benchmark",
    "security",
    "root cause",
    "debug",
    "optimize",
  ];
  const p = prompt.toLowerCase();
  return deepSignals.some((signal) => p.includes(signal)) || prompt.length > 420;
}

function detectProfile(prompt: string): OptimizationProfile {
  const p = prompt.toLowerCase();
  const researchSignals = [
    "literature review",
    "related work",
    "citation",
    "dissertation",
    "paper",
    "survey",
    "bibliography",
    "p4",
    "int telemetry",
    "gnn",
    "ids",
  ];
  return researchSignals.some((signal) => p.includes(signal)) ? "research" : "general";
}

function stripWrapperBlocks(prompt: string): string {
  return prompt
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, " ")
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shouldBypassOptimizer(prompt: string): boolean {
  const p = prompt.toLowerCase();
  if (p.includes("sage_search") && p.includes("\"results\"")) return true;
  if (p.includes("error: terminated") || p.includes("operation aborted")) return true;
  if (p.length > 12000 && (p.includes("\"results\"") || p.includes("tool_call") || p.includes("received request"))) return true;
  return false;
}

function inferResearchFromHints(hints: Array<{ path: string; snippet: string; score: number }>): boolean {
  const pathSignals = ["papers/", "dissertation/", "citations/", "related-work", "bibliography", "paper-"];
  const textSignals = ["literature review", "citation", "survey", "related work", "p4", "int telemetry", "gnn", "ids"];

  for (const hint of hints) {
    const path = hint.path.toLowerCase();
    const snippet = hint.snippet.toLowerCase();
    if (pathSignals.some((s) => path.includes(s))) return true;
    if (textSignals.some((s) => snippet.includes(s))) return true;
  }
  return false;
}

function isToolsBlock(text: string): boolean {
  return text.startsWith("## Sage MCP Tools Available");
}

function extractSkillKey(text: string): string | null {
  if (!text.startsWith("---\n# Skill:")) return null;
  const match = text.match(/^---\s*\n# Skill:\s*([^\n(]+)/i);
  if (!match) return "unknown";
  return match[1].trim().toLowerCase();
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function extractJsonObject(raw: string): string {
  const start = raw.indexOf("{");
  if (start < 0) return raw;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
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
      depth += 1;
      continue;
    }

    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }

  return raw;
}

function stripControlArtifacts(text: string): string {
  return text
    .replace(/<\/?(?:tool_call|function|parameter|system-reminder|think)[^>]*>/gi, " ")
    .replace(/<parameter=[^>]*>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeMetaPrompt(text: string): boolean {
  const lower = text.toLowerCase();
  const metaSignals = [
    "return strict json",
    "mode, optimizedprompt, executionbrief",
    "drafting the json",
    "you are a prompt optimizer",
    "<tool_call>",
    "</tool_call>",
    "<parameter",
    "</parameter>",
  ];
  return metaSignals.some((signal) => lower.includes(signal));
}

function safeOptimizerText(candidate: string, fallback: string, limit: number): string {
  const cleaned = stripControlArtifacts(candidate);
  if (!cleaned) {
    trace("optimizer_sanitized", { reason: "empty_after_strip", limit });
    return truncate(normalizePromptText(fallback), limit);
  }
  if (looksLikeMetaPrompt(cleaned)) {
    trace("optimizer_sanitized", { reason: "meta_prompt_detected", limit });
    return truncate(normalizePromptText(fallback), limit);
  }
  return truncate(cleaned, limit);
}

function parseOptimizerJson(raw: string, prompt: string): OptimizerResult | null {
  // Strip thinking blocks (Qwen 3.5 models produce <think>...</think> by default)
  const stripped = raw.replace(/<think>[\s\S]*?<\/think>/gi, " ").trim();
  const cleaned = extractJsonObject(
    stripped.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "")
  );
  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const mode = parsed.mode === "deep" ? "deep" : "fast";
    const optimizedPrompt = typeof parsed.optimizedPrompt === "string" ? parsed.optimizedPrompt.trim() : "";
    const executionBrief = typeof parsed.executionBrief === "string" ? parsed.executionBrief.trim() : "";
    const objective = typeof parsed.objective === "string" ? parsed.objective.trim() : "";
    const carryRaw = Array.isArray(parsed.carry) ? parsed.carry : [];
    const carry = normalizeLines(carryRaw.filter((v): v is string => typeof v === "string")).slice(0, MAX_CARRY_ITEMS);
    const confidence = typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence) ? parsed.confidence : 0.5;

    const fallback = normalizePromptText(prompt);
    return {
      mode,
      optimizedPrompt: safeOptimizerText(optimizedPrompt, fallback, 850),
      executionBrief: safeOptimizerText(executionBrief || "", "Execute faithfully and verify outcomes.", 700),
      objective: safeOptimizerText(objective || fallback, fallback, 240),
      carry,
      confidence,
    };
  } catch {
    return null;
  }
}

function parseOptimizerLoose(raw: string, prompt: string): OptimizerResult | null {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;

  const modeMatch = text.match(/\bmode\b[^a-z]*(fast|deep)\b/i);
  const mode: Mode = modeMatch?.[1]?.toLowerCase() === "deep" ? "deep" : needsDeepMode(prompt) ? "deep" : "fast";

  const objectiveMatch = text.match(/\bobjective\b\s*[:\-]\s*(.+?)(?:\s+\b(?:execution brief|optimized prompt|confidence|carry)\b|$)/i);
  const briefMatch = text.match(/\bexecution brief\b\s*[:\-]\s*(.+?)(?:\s+\b(?:optimized prompt|objective|confidence|carry)\b|$)/i);
  const promptMatch = text.match(/\b(?:optimized prompt(?: framing)?|rewritten prompt)\b\s*[:\-]\s*(.+?)(?:\s+\b(?:objective|execution brief|confidence|carry)\b|$)/i);
  const confidenceMatch = text.match(/\bconfidence\b\s*[:\-]\s*(0(?:\.\d+)?|1(?:\.0+)?)/i);

  const objective = safeOptimizerText((objectiveMatch?.[1] || prompt).trim(), prompt, 240);
  const executionBrief = safeOptimizerText((briefMatch?.[1] || text).trim(), "Execute faithfully and verify outcomes.", 700);
  const optimizedPrompt = safeOptimizerText((promptMatch?.[1] || prompt).trim(), prompt, 850);
  const confidence = confidenceMatch ? Number.parseFloat(confidenceMatch[1]) : 0.62;

  return {
    mode,
    optimizedPrompt,
    executionBrief,
    objective,
    carry: [],
    confidence: Number.isFinite(confidence) ? confidence : 0.62,
  };
}

function parseOracleJson(raw: string): OracleReview | null {
  const cleaned = extractJsonObject(
    raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "")
  );
  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const verdictRaw = typeof parsed.verdict === "string" ? parsed.verdict.toLowerCase() : "pass";
    const verdict: "pass" | "warn" | "fail" =
      verdictRaw === "fail" ? "fail" : verdictRaw === "warn" ? "warn" : "pass";
    const confidence = typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence) ? parsed.confidence : 0.55;
    const issues = Array.isArray(parsed.issues)
      ? normalizeLines(parsed.issues.filter((v): v is string => typeof v === "string")).slice(0, 5)
      : [];
    const requiredChecks = Array.isArray(parsed.requiredChecks)
      ? normalizeLines(parsed.requiredChecks.filter((v): v is string => typeof v === "string")).slice(0, 6)
      : [];

    return {
      verdict,
      confidence,
      issues,
      requiredChecks,
    };
  } catch {
    return null;
  }
}

/**
 * Stream a completion and abort only if no new events arrive within `inactivityMs`.
 * As long as LM Studio is actively generating tokens, the timer resets and the
 * request is never killed.
 */
async function completeWithInactivityTimeout(
  model: any,
  context: any,
  options: Record<string, any>,
  inactivityMs: number
): Promise<any> {
  const controller = new AbortController();
  // Merge caller's signal: if the caller already provided one, chain them
  const callerSignal = options.signal as AbortSignal | undefined;
  if (callerSignal) {
    callerSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const s = stream(model, context, { ...options, signal: controller.signal });
  let result: any = null;
  let inactivityTimer: ReturnType<typeof setTimeout> | null = null;

  const resetTimer = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      controller.abort();
    }, inactivityMs);
  };

  resetTimer();

  try {
    for await (const event of s) {
      resetTimer();
      if (event.type === "done") {
        result = event.message;
      } else if (event.type === "error") {
        result = event.error;
      }
    }
  } catch (err: any) {
    if (controller.signal.aborted && !callerSignal?.aborted) {
      throw new Error("inactivity_timeout");
    }
    throw err;
  } finally {
    if (inactivityTimer) clearTimeout(inactivityTimer);
  }

  if (!result) {
    throw new Error("stream ended without result");
  }
  return result;
}

function shouldRunOracle(prompt: string, result: OptimizerResult, profile: OptimizationProfile): boolean {
  if (!ORACLE_ENABLED) return false;
  if (profile === "research") return true;
  if (result.mode === "deep") return true;

  const p = prompt.toLowerCase();
  const riskySignals = ["security", "delete", "migration", "deploy", "prod", "permissions", "secrets", "auth", "refactor"];
  return riskySignals.some((signal) => p.includes(signal));
}

function resolveOracleModel(ctx: ExtensionContext): any {
  const provider = ENV_ORACLE_PROVIDER || resolveActiveProvider(ctx);
  const sc = getSidecarConfig(provider);
  const lookupProvider = ENV_ORACLE_PROVIDER || resolveSidecarProvider(provider);
  const primaryModelId = resolvePrimaryModelId(ctx);
  const oracleModelId = sc.oracle || primaryModelId;
  const candidates = normalizeLines([
    ORACLE_MODEL,
    oracleModelId,
    primaryModelId,
  ]);

  for (const id of candidates) {
    const model = ctx.modelRegistry.find(lookupProvider, id);
    if (model) return model;
  }
  return null;
}

function buildOraclePrompt(prompt: string, result: OptimizerResult, profile: OptimizationProfile): string {
  return [
    "You are an oracle validator for a coding agent execution brief.",
    "Return STRICT JSON only with keys: verdict, confidence, issues, requiredChecks.",
    "Rules:",
    "- verdict: pass|warn|fail",
    "- confidence: number 0.0-1.0",
    "- issues: max 5 concise items",
    "- requiredChecks: max 6 actionable checks",
    "- Prefer PASS unless clear risk.",
    `Profile: ${profile}`,
    `Mode: ${result.mode}`,
    `Objective: ${truncate(result.objective, 260)}`,
    `Execution brief: ${truncate(result.executionBrief, 520)}`,
    `Optimized prompt framing: ${truncate(result.optimizedPrompt, 520)}`,
    `User prompt: ${truncate(prompt, 900)}`,
  ].join("\n");
}

async function runOracleReview(
  ctx: ExtensionContext,
  prompt: string,
  result: OptimizerResult,
  profile: OptimizationProfile,
  signal?: AbortSignal
): Promise<{ review: OracleReview; modelId: string } | null> {
  const model = resolveOracleModel(ctx);
  if (!model) {
    trace("oracle_unavailable", { reason: "model_not_found", provider: ENV_ORACLE_PROVIDER || resolveActiveProvider(ctx) });
    return null;
  }

  const apiKey = await ctx.modelRegistry.getApiKey(model);
  if (!apiKey) {
    trace("oracle_unavailable", { reason: "no_api_key", modelId: model.id });
    return null;
  }

  trace("oracle_attempt", { modelId: model.id, profile, mode: result.mode });

  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  if (ctx.hasUI) {
    ctx.ui.setStatus("hybrid-oracle", `oracle:${model.id}`);
    ctx.ui.setWorkingMessage(`Oracle review running (${model.id})...`);
    progressTimer = setTimeout(() => {
      ctx.ui.notify(`Oracle review running (${model.id})...`);
    }, UI_PROGRESS_NOTIFY_MS);
  }

  try {
    const response = await completeWithInactivityTimeout(
      model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: buildOraclePrompt(prompt, result, profile) }],
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey, maxTokens: ORACLE_MAX_TOKENS, signal },
      ORACLE_INACTIVITY_MS
    );

    const { text, source: textSource } = extractResponseText(response);
    if (textSource === "thinking") {
      trace("oracle_using_thinking_fallback", { modelId: model.id, chars: text.length });
    }

    const parsed = parseOracleJson(text);
    if (!parsed) {
      trace("oracle_parse_failed", { modelId: model.id, responseChars: text.length, textSource });
      return null;
    }

    trace("oracle_success", {
      modelId: model.id,
      verdict: parsed.verdict,
      confidence: parsed.confidence,
      issueCount: parsed.issues.length,
      checkCount: parsed.requiredChecks.length,
    });
    return { review: parsed, modelId: model.id };
  } catch (error) {
    trace("oracle_error", { modelId: model.id, message: error instanceof Error ? error.message : "unknown" });
    return null;
  } finally {
    if (progressTimer) clearTimeout(progressTimer);
    if (ctx.hasUI) {
      ctx.ui.setWorkingMessage();
      ctx.ui.setStatus("hybrid-oracle", undefined);
    }
  }
}

function buildFallback(prompt: string): OptimizerResult {
  const mode = needsDeepMode(prompt) ? "deep" : "fast";
  return {
    mode,
    optimizedPrompt: truncate(prompt.replace(/\s+/g, " ").trim(), 600),
    executionBrief:
      mode === "deep"
        ? "Do a careful plan-then-execute pass, keep quality high, and validate assumptions before edits."
        : "Use concise steps, prefer direct execution, and keep output brief unless detail is requested.",
    objective: truncate(prompt, 240),
    carry: [],
    confidence: 0.35,
  };
}

function restoreState(ctx: ExtensionContext): OptimizerState {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as any;
    if (entry?.type !== "custom" || entry?.customType !== "hybrid-optimizer-state") continue;
    const data = entry.data as Partial<OptimizerState> | undefined;
    return {
      objective: typeof data?.objective === "string" ? data.objective : "",
      carry: Array.isArray(data?.carry) ? normalizeLines(data?.carry.filter((v): v is string => typeof v === "string")) : [],
      memoryHints: Array.isArray(data?.memoryHints)
        ? normalizeHintList(
            data.memoryHints.filter((v): v is { path: string; snippet: string; score: number } => typeof v === "object" && v !== null)
          )
        : [],
      lastOriginalPrompt: typeof data?.lastOriginalPrompt === "string" ? data.lastOriginalPrompt : "",
      lastOptimizedPrompt: typeof data?.lastOptimizedPrompt === "string" ? data.lastOptimizedPrompt : "",
      lastMode: data?.lastMode === "deep" ? "deep" : "fast",
      lastProfile: data?.lastProfile === "research" ? "research" : "general",
      lastOptimizationSource: data?.lastOptimizationSource === "model" ? "model" : "fallback",
      updatedAt: typeof data?.updatedAt === "number" ? data.updatedAt : Date.now(),
      optimizerModel: typeof data?.optimizerModel === "string" ? data.optimizerModel : ENV_OPTIMIZER_MODEL || "auto",
      optimizations: typeof data?.optimizations === "number" ? data.optimizations : 0,
      optimizerAttempts: typeof data?.optimizerAttempts === "number" ? data.optimizerAttempts : 0,
      optimizerSuccesses: typeof data?.optimizerSuccesses === "number" ? data.optimizerSuccesses : 0,
      optimizerFallbacks: typeof data?.optimizerFallbacks === "number" ? data.optimizerFallbacks : 0,
      failures: typeof data?.failures === "number" ? data.failures : 0,
    };
  }

  return {
    objective: "",
    carry: [],
    memoryHints: [],
    lastOriginalPrompt: "",
    lastOptimizedPrompt: "",
    lastMode: "fast",
    lastProfile: "general",
    lastOptimizationSource: "fallback",
    updatedAt: Date.now(),
    optimizerModel: ENV_OPTIMIZER_MODEL || "auto",
    optimizations: 0,
    optimizerAttempts: 0,
    optimizerSuccesses: 0,
    optimizerFallbacks: 0,
    failures: 0,
  };
}

function shouldSkipPrompt(prompt: string): boolean {
  if (!prompt.trim()) return true;
  const prefixes = ["[health-watchdog:auto-retry]", "[health-watchdog:cron]"];
  return prefixes.some((prefix) => prompt.startsWith(prefix));
}

function parseYamsHints(stdout: string): Array<{ path: string; snippet: string; score: number }> {
  try {
    const parsed = JSON.parse(stdout) as {
      results?: Array<{ path?: string; snippet?: string; score?: number }>;
    };
    const raw = Array.isArray(parsed.results) ? parsed.results : [];
    return normalizeHintList(
      raw.map((r) => ({
        path: typeof r.path === "string" ? r.path : "",
        snippet: typeof r.snippet === "string" ? r.snippet : "",
        score: typeof r.score === "number" ? r.score : 0,
      }))
    );
  } catch {
    return [];
  }
}

function normalizePromptText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatPromptPair(state: OptimizerState): string {
  const original = state.lastOriginalPrompt
    ? truncate(state.lastOriginalPrompt, PROMPT_PREVIEW_CHARS)
    : "(none captured yet)";
  const optimized = state.lastOptimizedPrompt
    ? truncate(state.lastOptimizedPrompt, PROMPT_PREVIEW_CHARS)
    : "(none captured yet)";
  return [`Original: ${original}`, `Optimized: ${optimized}`].join("\n");
}

function buildForwardedPrompt(originalPrompt: string, result: OptimizerResult): string {
  return [
    "[Hybrid Forwarded Prompt]",
    `Objective: ${truncate(result.objective || originalPrompt, 240)}`,
    `Original user request: ${truncate(normalizePromptText(originalPrompt), FORWARD_PROMPT_MAX_CHARS)}`,
    `Optimized execution prompt: ${truncate(normalizePromptText(result.optimizedPrompt), FORWARD_PROMPT_MAX_CHARS)}`,
    `Execution brief: ${truncate(normalizePromptText(result.executionBrief), 500)}`,
  ].join("\n");
}

function buildSystemPromptPatch(
  state: OptimizerState,
  result: OptimizerResult,
  profile: OptimizationProfile,
  oracleReview?: OracleReview,
  contextSteering?: ContextSteering | null,
  rlmHints?: RlmMemoryHint[]
): string {
  // Short-circuit: under high/critical pressure, emit a minimal patch to save tokens
  if (contextSteering && (contextSteering.pressure === "high" || contextSteering.pressure === "critical")) {
    const carryCompact = state.carry.length > 0 ? state.carry.slice(-3).join("; ") : "none";
    const rlmCompact =
      rlmHints && rlmHints.length > 0
        ? rlmHints
            .slice(0, 2)
            .map((h) => `[${h.chunkType}] ${truncate(h.snippet, 150)}`)
            .join(" | ")
        : null;
    const compactPatch = [
      "[Hybrid Guidance — compact]",
      `${profile}/${result.mode} conf=${result.confidence.toFixed(2)}`,
      `Objective: ${truncate(result.objective || state.objective, 200)}`,
      `Brief: ${truncate(result.executionBrief, 300)}`,
      `Budget: ${contextSteering.usageTokens.toLocaleString()}/${contextSteering.contextWindow.toLocaleString()} (${Math.round(contextSteering.usageRatio * 100)}%, ${contextSteering.pressure})`,
      `Carry: ${carryCompact}`,
      ...(rlmCompact ? [`Recalled: ${rlmCompact}`] : []),
      contextSteering.pressure === "critical"
        ? "CRITICAL: complete only highest-priority objective, no side quests, minimal output."
        : "HIGH: avoid broad scans, prioritize direct execution, keep output concise.",
      "- Preserve user intent. Verify hints against current state. Use structured write args.",
      oracleReview ? `Oracle: ${oracleReview.verdict}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return truncate(compactPatch, 1200);
  }

  const carryText =
    state.carry.length > 0 ? state.carry.map((line, i) => `${i + 1}. ${line}`).join("\n") : "- none";
  const hintsText =
    state.memoryHints.length > 0
      ? state.memoryHints
          .slice(0, MAX_HINTS_IN_PROMPT)
          .map(
            (hint, i) =>
              `${i + 1}. ${hint.path} (score ${hint.score.toFixed(3)}): ${truncate(hint.snippet, MAX_HINT_SNIPPET_CHARS)}`
          )
          .join("\n")
      : "- none";

  const rlmText =
    rlmHints && rlmHints.length > 0
      ? rlmHints
          .slice(0, RLM_MAX_HINTS_IN_PROMPT)
          .map(
            (hint, i) =>
              `${i + 1}. [${hint.chunkType}] (score ${hint.score.toFixed(3)}): ${truncate(hint.snippet, RLM_MAX_HINT_SNIPPET_CHARS)}`
          )
          .join("\n")
      : null;

  const patch = [
    "[Hybrid Guidance]",
    `Profile: ${profile}`,
    `Mode: ${result.mode}`,
    `Optimizer confidence: ${result.confidence.toFixed(2)}`,
    `Objective: ${truncate(result.objective || state.objective, 280)}`,
    `Execution brief: ${truncate(result.executionBrief, 700)}`,
    `Optimized prompt framing: ${truncate(result.optimizedPrompt, 850)}`,
    contextSteering
      ? `Context budget: ${contextSteering.usageTokens.toLocaleString()}/${contextSteering.contextWindow.toLocaleString()} (${Math.round(contextSteering.usageRatio * 100)}%, pressure=${contextSteering.pressure})`
      : "Context budget: unavailable",
    "Carry context:",
    carryText,
    "Retrieved memory hints:",
    hintsText,
    ...(rlmText
      ? ["Recalled session memory (from prior compacted context):", rlmText, "- Treat recalled memory as context from earlier in this session; verify against current state before acting on it."]
      : []),
    "Rules:",
    "- Preserve original user intent and constraints exactly.",
    "- Favor concise tool plans when possible, but switch to deeper reasoning for risky changes.",
    "- Treat memory hints as candidate evidence and verify against current files/tool output.",
    "- ALWAYS prefer YAMS search (yams search <query>) over find/ls for discovering files. Use YAMS results to guide targeted file reads.",
    "- For diagnostics/health checks, avoid shell pipelines that mask failures (for example: `cmd 2>&1 | head`, `... | tail`, or pipes to formatting tools). Run the command directly first so the true exit status and full error are visible.",
    "- If output is large, prefer tool-level truncation, follow-up reads, or a second targeted command instead of piping through `head`/`tail`.",
    profile === "research"
      ? "- For literature tasks, prioritize local repo evidence in code->papers->docs order before external prompts/skills lookups."
      : "- Keep tool usage minimal and targeted.",
    profile === "research"
      ? "- Avoid searching Sage prompt/skill catalogs for paper content unless the user explicitly asks for prompt libraries."
      : "- Avoid redundant broad searches when direct file reads are available.",
    "- For write tool calls, always send structured arguments containing both path and content; never emit empty write args.",
    "- Use realistic tool timeouts: avoid 5s limits on repo scans/reads; use >=60s for potentially heavy bash/search commands unless user asks for fast-fail.",
    "- Use normal exploration depth when context budget is healthy.",
    "- Preserve clarity and traceability in final output.",
    oracleReview
      ? `- Oracle verdict: ${oracleReview.verdict} (${oracleReview.confidence.toFixed(2)}).`
      : "- Oracle verdict: not available.",
    oracleReview && oracleReview.requiredChecks.length > 0
      ? `- Oracle required checks: ${oracleReview.requiredChecks.join(" | ")}`
      : "- Oracle required checks: none.",
    "- If uncertain, ask one focused clarifying question after doing all non-blocked work.",
  ].join("\n");

  return truncate(patch, MAX_BRIEF_CHARS);
}

function resolveOptimizerModels(ctx: ExtensionContext, profile: OptimizationProfile): any[] {
  // Optimizer models are always the dedicated sidecar models, never the primary.
  // This prevents sending Qwen-formatted prompts to non-Qwen primary models
  // and avoids wasting time on models that can't produce structured optimizer JSON.
  const provider = ENV_OPTIMIZER_PROVIDER || resolveActiveProvider(ctx);
  const sc = getSidecarConfig(provider);
  const lookupProvider = ENV_OPTIMIZER_PROVIDER || resolveSidecarProvider(provider);
  const optimizerModel = ENV_OPTIMIZER_MODEL || sc.optimizer;
  const fallbackModel = ENV_FALLBACK_OPTIMIZER_MODEL || sc.optimizerFallback;
  const researchModel = ENV_RESEARCH_OPTIMIZER_MODEL || sc.researchOptimizer;

  const raw =
    profile === "research"
      ? normalizeLines([researchModel, optimizerModel, fallbackModel])
      : normalizeLines([optimizerModel, fallbackModel]);
  // Deduplicate: preferred model candidates can collapse to the same model id.
  const preferred = [...new Set(raw)];
  const models: any[] = [];
  for (const id of preferred) {
    const model = ctx.modelRegistry.find(lookupProvider, id);
    if (model) models.push(model);
  }
  return models;
}

async function optimizeWithModel(
  ctx: ExtensionContext,
  prompt: string,
  state: OptimizerState,
  profile: OptimizationProfile,
  signal?: AbortSignal,
  contextSteering?: ContextSteering | null
): Promise<{ result: OptimizerResult; modelId: string } | null> {
  const models = resolveOptimizerModels(ctx, profile);
  const activeProvider = ENV_OPTIMIZER_PROVIDER || resolveActiveProvider(ctx);
  if (models.length === 0) {
    trace("optimizer_model_unavailable", { provider: activeProvider });
    return null;
  }

  const carryContext = state.carry.length > 0 ? state.carry.map((line) => `- ${line}`).join("\n") : "- none";

  const userMessage = [
    "You are a prompt optimizer for a coding agent.",
    `Optimization profile: ${profile}`,
    "Return STRICT JSON only with keys:",
    "mode, optimizedPrompt, executionBrief, objective, carry, confidence",
    "Rules:",
    "- Keep optimizedPrompt faithful to user intent.",
    "- executionBrief must be concise and actionable.",
    "- carry must contain <= 6 short durable facts.",
    "- mode must be fast or deep.",
    "- confidence range 0.0 to 1.0.",
    "- If planning a write tool call, include explicit JSON fields path and content.",
    profile === "research"
      ? "- For research/literature prompts, emphasize evidence-first workflow: local code and docs first, then external sources."
      : "- Keep execution oriented and concise.",
    profile === "research"
      ? "- Do NOT recommend searching prompt/skill catalogs for paper content unless explicitly requested."
      : "- Prefer direct file operations over broad catalog searches.",
    contextSteering
      ? `Context budget: used=${contextSteering.usageTokens} window=${contextSteering.contextWindow} available=${contextSteering.availableTokens} ratio=${contextSteering.usageRatio.toFixed(3)} pressure=${contextSteering.pressure}`
      : "Context budget: unavailable",
    contextSteering && (contextSteering.pressure === "high" || contextSteering.pressure === "critical")
      ? "- High context pressure: compress optimizedPrompt/executionBrief to essentials and avoid introducing broad exploration."
      : "- Normal context pressure: optimize for clarity and robust execution.",
    contextSteering && contextSteering.pressure === "critical"
      ? "- Critical context pressure: favor narrow, direct, low-token plans and keep output minimal."
      : "- Keep outputs practical and actionable.",
    "Current carry context:",
    carryContext,
    "User prompt:",
    prompt,
  ].join("\n");

  const optimizerMaxTokens =
    contextSteering && (contextSteering.pressure === "high" || contextSteering.pressure === "critical")
      ? Math.min(OPTIMIZER_MAX_TOKENS, 420)
      : OPTIMIZER_MAX_TOKENS;

  for (const model of models) {
    const apiKey = await ctx.modelRegistry.getApiKey(model);
    if (!apiKey) {
      trace("optimizer_model_unavailable", {
        provider: activeProvider,
        modelId: model.id,
        reason: "no_api_key",
      });
      continue;
    }

    trace("optimizer_model_call", {
      provider: activeProvider,
      modelId: model.id,
      promptChars: prompt.length,
      contextPressure: contextSteering?.pressure || "unknown",
      optimizerMaxTokens,
    });

    let progressTimer: ReturnType<typeof setTimeout> | null = null;
    let longRunningNotified = false;
    if (ctx.hasUI) {
      ctx.ui.setStatus("hybrid-run", `optimizer:${model.id}`);
      ctx.ui.setWorkingMessage(`Hybrid optimizer running (${model.id})...`);
      progressTimer = setTimeout(() => {
        ctx.ui.notify(`Hybrid optimizer running (${model.id})...`);
        longRunningNotified = true;
      }, UI_PROGRESS_NOTIFY_MS);
    }

    let succeeded = false;
    try {
      const response = await completeWithInactivityTimeout(
        model,
        {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: userMessage }],
              timestamp: Date.now(),
            },
          ],
        },
        { apiKey, maxTokens: optimizerMaxTokens, signal },
        OPTIMIZER_INACTIVITY_MS
      );

      const { text, source: textSource } = extractResponseText(response);
      if (textSource === "thinking") {
        trace("optimizer_model_using_thinking_fallback", {
          provider: activeProvider,
          modelId: model.id,
          chars: text.length,
        });
      }

      const parsed = parseOptimizerJson(text, prompt);
      if (!parsed) {
        if (ALLOW_LOOSE_PARSE) {
          const loose = parseOptimizerLoose(text, prompt);
          if (loose) {
            trace("optimizer_model_loose_parsed", {
              provider: activeProvider,
              modelId: model.id,
              mode: loose.mode,
              confidence: loose.confidence,
            });
            succeeded = true;
            return { result: loose, modelId: model.id };
          }
          trace("optimizer_model_loose_rejected", {
            provider: activeProvider,
            modelId: model.id,
            responseChars: text.length,
          });
        }
        trace("optimizer_model_parse_failed", {
          provider: activeProvider,
          modelId: model.id,
          responseChars: text.length,
        });
        continue;
      }

      trace("optimizer_model_parsed", {
        provider: activeProvider,
        modelId: model.id,
        mode: parsed.mode,
        confidence: parsed.confidence,
      });
      succeeded = true;
      return { result: parsed, modelId: model.id };
    } finally {
      if (progressTimer) clearTimeout(progressTimer);
      if (ctx.hasUI) {
        ctx.ui.setWorkingMessage();
        ctx.ui.setStatus("hybrid-run", undefined);
        if (longRunningNotified) {
          ctx.ui.notify(succeeded
            ? `Hybrid optimizer finished (${model.id}).`
            : `Hybrid optimizer failed to parse (${model.id}), trying next...`);
        }
      }
    }
  }

  return null;
}

async function fetchYamsHints(
  pi: ExtensionAPI,
  prompt: string,
  state: OptimizerState,
  signal?: AbortSignal
): Promise<Array<{ path: string; snippet: string; score: number }>> {
  if (!YAMS_ENABLED) return [];

  const query = normalizeLines([
    state.objective,
    ...state.carry.slice(-3),
    prompt,
  ])
    .join(" ")
    .slice(0, 900);

  if (!query.trim()) return [];

  const result = await pi.exec(
    "yams",
    ["search", "--json", "--cwd", "--limit", String(Math.max(1, YAMS_LIMIT)), query],
    { timeout: YAMS_TIMEOUT_MS, signal }
  );

  if (result.code !== 0 || !result.stdout) return [];
  return parseYamsHints(result.stdout);
}

// ---------------------------------------------------------------------------
// RLM: Retrieval-augmented Long Memory
// ---------------------------------------------------------------------------

/** Heuristic: detect conclusion/decision sentences in assistant output. */
function extractConclusions(text: string): string | null {
  const signals = [
    /(?:^|\n)\s*(?:decided|decision|approach|conclusion|found|the issue|root cause|result|summary|key finding|accomplished|completed)[:\s]/im,
    /(?:^|\n)\s*(?:I'll |Let's |We should |The plan is |Going with |Choosing )/m,
    /(?:^|\n)\s*(?:##\s+(?:Goal|Summary|Decision|Result|Finding|Progress|Accomplished|Plan))/m,
  ];

  const lines = text.split("\n");
  const kept: string[] = [];
  let capturing = false;
  let capturedLines = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (capturing && capturedLines > 0) {
        capturing = false;
      }
      continue;
    }
    // Start capturing when a signal line is found
    if (!capturing && signals.some((re) => re.test(trimmed))) {
      capturing = true;
      capturedLines = 0;
    }
    if (capturing) {
      kept.push(trimmed);
      capturedLines += 1;
      if (capturedLines >= 8) capturing = false; // cap paragraph length
    }
  }

  if (kept.length === 0) return null;
  const joined = kept.join("\n");
  return joined.length > RLM_MAX_CHUNK_CHARS ? `${joined.slice(0, RLM_MAX_CHUNK_CHARS - 3)}...` : joined;
}

/** Extract file paths from text. */
function extractFilePaths(text: string): string[] {
  const pathPattern = /(?:\/[\w.@-]+){2,}(?:\.\w{1,10})?/g;
  const matches = text.match(pathPattern) || [];
  const unique = [...new Set(matches)];
  // Filter out common non-path patterns
  return unique
    .filter((p) => !p.startsWith("/tmp/") && !p.includes("/node_modules/") && p.length < 200)
    .slice(0, 25);
}

/** Extract structured memory chunks from messages about to be evicted. */
function extractMemoryChunks(messages: any[], state: OptimizerState): RlmChunk[] {
  const chunks: RlmChunk[] = [];

  // 1. Objective chunk: always store current objective + carry
  if (state.objective) {
    const carryText = state.carry.length > 0 ? `\nCarry: ${state.carry.join("; ")}` : "";
    const objectiveContent = `Objective: ${state.objective}${carryText}`;
    chunks.push({
      type: "objective",
      content: objectiveContent.length > RLM_MAX_CHUNK_CHARS
        ? `${objectiveContent.slice(0, RLM_MAX_CHUNK_CHARS - 3)}...`
        : objectiveContent,
    });
  }

  // 2. Scan messages for user requests and assistant findings
  const allFilePaths: string[] = [];
  for (const msg of messages) {
    const text = extractText(msg?.content);
    if (!text || text.length < 50) continue;

    // Collect file paths from all messages
    allFilePaths.push(...extractFilePaths(text));

    if (msg?.role === "user" && chunks.length < RLM_MAX_CHUNKS_PER_COMPACTION) {
      const cleaned = stripWrapperBlocks(text);
      if (cleaned.length > 80 && cleaned.length < 6000) {
        const content = `User request: ${cleaned.length > RLM_MAX_CHUNK_CHARS ? `${cleaned.slice(0, RLM_MAX_CHUNK_CHARS - 3)}...` : cleaned}`;
        chunks.push({ type: "user-request", content });
      }
    } else if (msg?.role === "assistant" && chunks.length < RLM_MAX_CHUNKS_PER_COMPACTION) {
      // Strip thinking blocks before extraction
      const withoutThinking = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      if (withoutThinking.length < 80) continue;
      const conclusions = extractConclusions(withoutThinking);
      if (conclusions && conclusions.length > 60) {
        chunks.push({ type: "assistant-finding", content: conclusions });
      }
    }
  }

  // 3. File context chunk: consolidated paths
  const uniquePaths = [...new Set(allFilePaths)].slice(0, 20);
  if (uniquePaths.length > 0 && chunks.length < RLM_MAX_CHUNKS_PER_COMPACTION) {
    chunks.push({
      type: "file-context",
      content: `Relevant files from evicted context: ${uniquePaths.join(", ")}`,
    });
  }

  return chunks.slice(0, RLM_MAX_CHUNKS_PER_COMPACTION);
}

// ---------------------------------------------------------------------------
// RLM: Model-based memory extraction
// ---------------------------------------------------------------------------

function resolveRlmExtractorModel(ctx: ExtensionContext): any {
  // RLM extractor only tries the configured sidecar model.
  // On failure the caller falls back to heuristic extraction -- no other LLMs.
  const provider = ENV_RLM_EXTRACTOR_PROVIDER || resolveActiveProvider(ctx);
  const sc = getSidecarConfig(provider);
  const lookupProvider = ENV_RLM_EXTRACTOR_PROVIDER || resolveSidecarProvider(provider);
  const extractorModel = ENV_RLM_EXTRACTOR_MODEL || sc.rlmExtractor;
  const candidates = normalizeLines([extractorModel]);

  for (const id of candidates) {
    const model = ctx.modelRegistry.find(lookupProvider, id);
    if (model) return model;
  }
  return null;
}

function buildRlmExtractorPrompt(messages: any[], state: OptimizerState): string {
  const objectiveCtx = state.objective ? `Current objective: ${state.objective}` : "No objective set.";
  const carryCtx = state.carry.length > 0 ? `Carry context: ${state.carry.join("; ")}` : "";

  // Build a condensed transcript from the messages being evicted
  let transcript = "";
  let charBudget = RLM_EXTRACTOR_MAX_INPUT_CHARS;
  for (const msg of messages) {
    if (charBudget <= 0) break;
    const role = msg?.role || "unknown";
    let text = extractText(msg?.content) || "";
    // Strip thinking blocks from assistant messages
    if (role === "assistant") {
      text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    }
    if (!text || text.length < 30) continue;
    const truncated = text.length > 1500 ? `${text.slice(0, 1500)}...` : text;
    transcript += `[${role}]: ${truncated}\n\n`;
    charBudget -= truncated.length + role.length + 6;
  }

  return [
    "You are a memory extraction system for a coding assistant. Your job is to extract the most important information from conversation messages that are about to be evicted from context.",
    "",
    "Return STRICT JSON only: an array of objects with keys: type, content",
    "Rules:",
    `- type must be one of: objective, user-request, assistant-finding, file-context`,
    `- content must be a concise string (max ${RLM_MAX_CHUNK_CHARS} chars)`,
    `- Return at most ${RLM_MAX_CHUNKS_PER_COMPACTION} chunks`,
    "- Prioritize: decisions made, root causes found, user requirements, file paths worked on, key findings",
    "- Omit trivial or transient information (greetings, acknowledgments, intermediate debugging steps)",
    "- For file-context type: list the most important file paths mentioned, as a comma-separated string",
    "- For assistant-finding type: summarize conclusions, decisions, discoveries, or root cause analyses",
    "- For user-request type: capture the user's core intent or requirement",
    "- For objective type: capture the overall session goal if discernible",
    "- If no meaningful content can be extracted, return an empty array: []",
    "",
    objectiveCtx,
    carryCtx,
    "",
    "Messages to extract from:",
    transcript.trim(),
  ].join("\n");
}

async function extractMemoryChunksWithModel(
  ctx: ExtensionContext,
  messages: any[],
  state: OptimizerState
): Promise<RlmChunk[] | null> {
  const model = resolveRlmExtractorModel(ctx);
  if (!model) {
    trace("rlm_extractor_model_unavailable", { reason: "model_not_found", provider: ENV_RLM_EXTRACTOR_PROVIDER || resolveActiveProvider(ctx) });
    return null; // Signal to fall back to heuristic
  }

  const apiKey = await ctx.modelRegistry.getApiKey(model);
  if (!apiKey) {
    trace("rlm_extractor_model_unavailable", { reason: "no_api_key", modelId: model.id });
    return null;
  }

  const prompt = buildRlmExtractorPrompt(messages, state);

  trace("rlm_extractor_model_attempt", {
    modelId: model.id,
    messagesCount: messages.length,
    promptChars: prompt.length,
  });

  try {
    const response = await completeWithInactivityTimeout(
      model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: prompt }],
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey, maxTokens: RLM_EXTRACTOR_MAX_TOKENS },
      RLM_EXTRACTOR_INACTIVITY_MS
    );

    const { text, source: textSource } = extractResponseText(response);
    if (textSource === "thinking") {
      trace("rlm_extractor_using_thinking_fallback", { modelId: model.id, chars: text.length });
    }

    // Strip markdown code fences if present
    const jsonText = text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```$/m, "").trim();

    let parsed: any;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      trace("rlm_extractor_model_parse_failed", { modelId: model.id, responseChars: text.length, textSource });
      return null;
    }

    if (!Array.isArray(parsed)) {
      trace("rlm_extractor_model_not_array", { modelId: model.id, type: typeof parsed });
      return null;
    }

    const validTypes = new Set(["objective", "user-request", "assistant-finding", "file-context"]);
    const chunks: RlmChunk[] = [];
    for (const item of parsed) {
      if (
        item &&
        typeof item.type === "string" &&
        validTypes.has(item.type) &&
        typeof item.content === "string" &&
        item.content.length > 10
      ) {
        chunks.push({
          type: item.type as RlmChunk["type"],
          content: item.content.length > RLM_MAX_CHUNK_CHARS
            ? `${item.content.slice(0, RLM_MAX_CHUNK_CHARS - 3)}...`
            : item.content,
        });
      }
      if (chunks.length >= RLM_MAX_CHUNKS_PER_COMPACTION) break;
    }

    trace("rlm_extractor_model_success", {
      modelId: model.id,
      extractedChunks: chunks.length,
      chunkTypes: chunks.map((c) => c.type),
    });

    return chunks;
  } catch (err: any) {
    const reason = err?.message?.includes("inactivity_timeout") ? "inactivity_timeout" : "error";
    trace("rlm_extractor_model_failed", {
      modelId: model.id,
      reason,
      error: String(err).slice(0, 300),
    });
    return null; // Signal to fall back to heuristic
  }
}

/** Store a single RLM chunk in YAMS via temp file. */
async function storeRlmChunk(
  pi: ExtensionAPI,
  name: string,
  content: string,
  metadata: string,
  sessionId: string
): Promise<boolean> {
  const tmpFile = path.join(tmpdir(), `pi-rlm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  // Include session-scoped tag for tiered retrieval (session-first, then global)
  const tags = `${RLM_STORE_TAGS},session:${sessionId}`;
  try {
    fs.writeFileSync(tmpFile, content, "utf-8");
    const result = await pi.exec(
      "yams",
      [
        "add",
        tmpFile,
        "--name",
        name,
        "--collection",
        RLM_COLLECTION,
        "--tags",
        tags,
        "--metadata",
        metadata,
      ],
      { timeout: RLM_STORE_TIMEOUT_MS }
    );
    // Defer cleanup — YAMS add is async, daemon reads the file later.
    rlmTempFileManager.register(tmpFile);
    return result.code === 0;
  } catch {
    // Exec failed — still defer cleanup in case daemon is mid-read.
    rlmTempFileManager.register(tmpFile);
    return false;
  }
}

/** Store extracted memory chunks in YAMS. Fire-and-forget safe. */
async function storeMemoryChunks(
  pi: ExtensionAPI,
  chunks: RlmChunk[],
  sessionId: string,
  turnNumber: number,
  objective: string
): Promise<{ stored: number; failed: number }> {
  let stored = 0;
  let failed = 0;
  const truncatedObjective = objective.slice(0, 120).replace(/[,=]/g, "_");

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const name = `pi-rlm-${sessionId}-t${turnNumber}-${chunk.type}-${i}`;
    const metadata = `chunk_type=${chunk.type},session_id=${sessionId},turn=${turnNumber},objective=${truncatedObjective}`;
    const ok = await storeRlmChunk(pi, name, chunk.content, metadata, sessionId);
    if (ok) {
      stored += 1;
    } else {
      failed += 1;
    }
  }

  return { stored, failed };
}

/** Parse YAMS search results into RlmMemoryHint[], filtering by score and deduplicating. */
function parseRlmSearchResults(
  stdout: string,
  seenIds: Set<string>
): RlmMemoryHint[] {
  try {
    const parsed = JSON.parse(stdout);
    const results: any[] = Array.isArray(parsed) ? parsed : parsed.results || [];
    const hints: RlmMemoryHint[] = [];
    for (const r of results) {
      if (
        typeof r.score === "number" &&
        r.score >= RLM_MIN_SCORE &&
        typeof r.snippet === "string" &&
        r.snippet.length > 0
      ) {
        // Deduplicate across phases by YAMS doc id (or path as fallback)
        const dedupeKey = String(r.id || r.path || r.snippet.slice(0, 80));
        if (seenIds.has(dedupeKey)) continue;
        seenIds.add(dedupeKey);
        hints.push({
          snippet: r.snippet.replace(/\s+/g, " ").trim(),
          score: r.score,
          chunkType: r.metadata?.chunk_type || "unknown",
        });
      }
    }
    return hints;
  } catch {
    return [];
  }
}

/**
 * Retrieve relevant session memory chunks from YAMS.
 * Two-phase tiered retrieval:
 *   Phase 1: Session-scoped results (tag: session:<sessionId>) -- prioritize current session context.
 *   Phase 2: Global RLM results (tag: rlm) -- fill remaining slots with cross-session long-term memory.
 * Deduplication ensures no snippet appears twice.
 */
async function fetchRlmMemory(
  pi: ExtensionAPI,
  prompt: string,
  state: OptimizerState,
  sessionId: string,
  signal?: AbortSignal
): Promise<RlmMemoryHint[]> {
  if (!RLM_ENABLED) return [];

  const query = normalizeLines([state.objective, ...state.carry.slice(-3), prompt])
    .join(" ")
    .slice(0, 900);

  if (!query.trim()) return [];

  const seenIds = new Set<string>();
  const allHints: RlmMemoryHint[] = [];

  // Phase 1: Session-scoped retrieval (current session memories)
  try {
    const sessionResult = await pi.exec(
      "yams",
      [
        "search",
        "--json",
        "--tags",
        `session:${sessionId}`,
        "--similarity",
        RLM_SEARCH_SIMILARITY,
        "--limit",
        String(RLM_RETRIEVE_LIMIT + 2),
        query,
      ],
      { timeout: RLM_RETRIEVE_TIMEOUT_MS, signal }
    );
    if (sessionResult.code === 0 && sessionResult.stdout) {
      const sessionHints = parseRlmSearchResults(sessionResult.stdout, seenIds);
      allHints.push(...sessionHints.slice(0, RLM_RETRIEVE_LIMIT));
    }
  } catch {
    // Session-scoped search failed; continue to global phase.
  }

  // Phase 2: Global RLM retrieval (cross-session long-term memory)
  const remaining = RLM_RETRIEVE_LIMIT - allHints.length;
  if (remaining > 0 && !signal?.aborted) {
    try {
      const globalResult = await pi.exec(
        "yams",
        [
          "search",
          "--json",
          "--tags",
          "rlm",
          "--similarity",
          RLM_SEARCH_SIMILARITY,
          "--limit",
          String(remaining + 2),
          query,
        ],
        { timeout: RLM_RETRIEVE_TIMEOUT_MS, signal }
      );
      if (globalResult.code === 0 && globalResult.stdout) {
        const globalHints = parseRlmSearchResults(globalResult.stdout, seenIds);
        allHints.push(...globalHints.slice(0, remaining));
      }
    } catch {
      // Global search failed; return whatever session phase found.
    }
  }

  return allHints.slice(0, RLM_RETRIEVE_LIMIT);
}

// ---------------------------------------------------------------------------
// DCS integration helpers for RLM enrichment and deep recall
// ---------------------------------------------------------------------------

/**
 * Extract the final output from DCS CLI stdout.
 * DCS prints a rich log then an "Output" marker followed by the actual result.
 */
function extractDcsOutput(stdout: string): string {
  const marker = "Output";
  const idx = stdout.lastIndexOf(marker);
  if (idx < 0) return stdout.trim();
  const tail = stdout.slice(idx + marker.length);
  const cleaned = tail.replace(/^[\s\-\u2500]+/gm, "").trim();
  if (!cleaned) return stdout.trim();
  return cleaned;
}

/**
 * Run the DCS research-agent CLI with a task and timeout.
 * Returns the extracted output string on success, null on failure.
 */
async function runDcs(
  task: string,
  timeoutMs: number,
  contextProfile = "small"
): Promise<{ output: string | null; error?: string }> {
  const args = ["run", task, "--context-profile", contextProfile];
  try {
    const { stdout, stderr } = await execFileAsync(DCS_CLI, args, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    const output = extractDcsOutput(stdout || stderr || "");
    if (!output || output.length < 20) {
      return { output: null, error: "empty_output" };
    }
    // Strip residual <think> blocks
    const cleaned = output.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    return { output: cleaned };
  } catch (err: any) {
    const killed = err?.killed === true;
    return {
      output: null,
      error: killed ? "timeout" : `exec_error: ${String(err?.message || err).slice(0, 200)}`,
    };
  }
}

/**
 * DCS session-start enrichment: given RLM memories from previous sessions,
 * synthesize a rich context briefing using DCS multi-hop retrieval.
 */
async function enrichSessionWithDcs(
  memories: Array<{ snippet: string; score: number; path?: string }>
): Promise<string | null> {
  if (!RLM_DCS_SESSION_ENRICHMENT || memories.length === 0) return null;

  const memoryText = memories
    .map((m, i) => `[Memory ${i + 1}] (score: ${m.score.toFixed(3)})\n${truncate(m.snippet, 600)}`)
    .join("\n\n");

  const task = [
    "Given these session memories from previous coding sessions, synthesize a rich context briefing for starting a new session.",
    "Search project knowledge in YAMS to connect these memories to the broader codebase and recent changes.",
    "Focus on: active goals, recent decisions, blocking issues, and key file paths that matter right now.",
    "Be concise but specific. Preserve exact file paths and function names.",
    "",
    `<memories>\n${memoryText}\n</memories>`,
  ].join("\n");

  trace("dcs_session_enrichment_attempt", { memoryCount: memories.length });

  const result = await runDcs(task, RLM_DCS_SESSION_TIMEOUT_MS, "small");
  if (result.output) {
    trace("dcs_session_enrichment_success", { outputChars: result.output.length });
    return result.output;
  }

  trace("dcs_session_enrichment_failed", { error: result.error });
  return null;
}

/**
 * DCS deep recall: run a deep multi-hop retrieval on a user-specified topic.
 * Returns the synthesized result or null.
 */
async function dcsDeepRecall(topic: string): Promise<string | null> {
  const task = [
    `Deep recall on topic: ${topic}`,
    "Search all available memories, project knowledge, and code context in YAMS.",
    "Synthesize a comprehensive answer covering: relevant decisions, file paths, code patterns, and any known issues.",
    "Include exact file paths, function names, and configuration values where applicable.",
    "Be thorough -- this is an on-demand deep retrieval request.",
  ].join("\n");

  trace("dcs_deep_recall_attempt", { topic: truncate(topic, 200) });

  const result = await runDcs(task, RLM_DEEP_RECALL_TIMEOUT_MS, "large");
  if (result.output) {
    trace("dcs_deep_recall_success", { topic: truncate(topic, 200), outputChars: result.output.length });
    return result.output;
  }

  trace("dcs_deep_recall_failed", { topic: truncate(topic, 200), error: result.error });
  return null;
}

export default function hybridOptimizerExtension(pi: ExtensionAPI): void {
  let state: OptimizerState = {
    objective: "",
    carry: [],
    memoryHints: [],
    lastOriginalPrompt: "",
    lastOptimizedPrompt: "",
    lastMode: "fast",
    lastProfile: "general",
    lastOptimizationSource: "fallback",
    updatedAt: Date.now(),
    optimizerModel: ENV_OPTIMIZER_MODEL || "auto",
    optimizations: 0,
    optimizerAttempts: 0,
    optimizerSuccesses: 0,
    optimizerFallbacks: 0,
    failures: 0,
  };
  let compactionInFlight = false;
  let compactionStartedAt = 0;
  let compactionPollTimer: ReturnType<typeof setInterval> | null = null;
  let unavailableNotified = false;
  let yamsUnavailableNotified = false;
  let lastCompactionAt = 0;
  let effectiveContextWindow: number | null = null;

  /** Stop the compaction-progress poll timer. */
  function stopCompactionPoll(): void {
    if (compactionPollTimer !== null) {
      clearInterval(compactionPollTimer);
      compactionPollTimer = null;
    }
  }

  /**
   * Start polling to monitor compaction progress.
   * We never forcibly reset `compactionInFlight` — only the real onComplete/onError
   * callbacks do that.  The poll just logs warnings so operators can see what's happening.
   * After COMPACTION_STALL_THRESHOLD_MS with no resolution, we log a critical stall
   * warning and clear the flag as a last resort so future compactions aren't blocked
   * forever.
   */
  function startCompactionPoll(ctx: ExtensionContext): void {
    stopCompactionPoll();
    compactionPollTimer = setInterval(() => {
      if (!compactionInFlight) {
        // Compaction resolved while we were sleeping — clean up.
        stopCompactionPoll();
        return;
      }
      const elapsed = Date.now() - compactionStartedAt;
      const elapsedSec = Math.round(elapsed / 1000);

      if (elapsed >= COMPACTION_STALL_THRESHOLD_MS) {
        // True stall — the 9b model or DCS pipeline is unresponsive.
        compactionInFlight = false;
        stopCompactionPoll();
        trace("compaction_stall_cleared", {
          elapsedMs: elapsed,
          stallThresholdMs: COMPACTION_STALL_THRESHOLD_MS,
        });
        notify(
          ctx,
          `Compaction appears stalled after ${elapsedSec}s — clearing flag so future compactions can proceed.`,
          "warning"
        );
        return;
      }

      // Periodic progress log (not a failure — just visibility).
      trace("compaction_poll", { elapsedMs: elapsed });
      if (elapsed > 60_000) {
        // Only surface to user after 1 min so short compactions stay quiet.
        notify(ctx, `Compaction still processing (${elapsedSec}s elapsed)...`);
      }
    }, COMPACTION_POLL_INTERVAL_MS);
  }

  // RLM session state
  let rlmSessionId = `pi-${Date.now().toString(36)}`;
  let rlmTurnCounter = 0;
  let rlmLastMemoryHints: RlmMemoryHint[] = [];
  let rlmUnavailableNotified = false;
  let rlmDcsEnriched = false;
  let dcsEnrichmentText: string | null = null;

  function setStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const t = ctx.ui.theme;
    const mode = state.lastMode === "deep" ? t.fg("warning", "deep") : t.fg("accent", "fast");
    const source = state.lastOptimizationSource === "model" ? "m" : "f";
    const profile = state.lastProfile === "research" ? "r" : "g";
    const hints = t.fg("dim", ` h:${state.memoryHints.length}`);
    ctx.ui.setStatus(
      "hybrid-opt",
      `${t.fg("dim", "hybrid:")}${mode}${t.fg("dim", ` s:${source} p:${profile}`)}${hints}`
    );
  }

  function auditModelAvailability(ctx: ExtensionContext): string[] {
    const provider = ENV_OPTIMIZER_PROVIDER || resolveActiveProvider(ctx);
    const oracleProvider = ENV_ORACLE_PROVIDER || provider;
    const rlmProvider = ENV_RLM_EXTRACTOR_PROVIDER || provider;
    const sc = getSidecarConfig(provider);
    const oracleSc = getSidecarConfig(oracleProvider);
    const rlmSc = getSidecarConfig(rlmProvider);
    // For registry lookups, use the sidecar provider (handles llama-cpp → llama-cpp-sidecar redirect)
    const lookupProvider = ENV_OPTIMIZER_PROVIDER || resolveSidecarProvider(provider);
    const oracleLookup = ENV_ORACLE_PROVIDER || resolveSidecarProvider(oracleProvider);
    const rlmLookup = ENV_RLM_EXTRACTOR_PROVIDER || resolveSidecarProvider(rlmProvider);
    const primaryModelId = resolvePrimaryModelId(ctx);
    const required = [
      { role: "optimizer", provider: lookupProvider, id: ENV_OPTIMIZER_MODEL || sc.optimizer },
      { role: "research-optimizer", provider: lookupProvider, id: ENV_RESEARCH_OPTIMIZER_MODEL || sc.researchOptimizer },
      { role: "oracle", provider: oracleLookup, id: ORACLE_MODEL || oracleSc.oracle || primaryModelId },
    ];
    if (RLM_ENABLED && RLM_EXTRACTOR_MODE === "model") {
      required.push({ role: "rlm-extractor", provider: rlmLookup, id: ENV_RLM_EXTRACTOR_MODEL || rlmSc.rlmExtractor });
    }
    const missing: string[] = [];
    for (const check of required) {
      if (!check.id) {
        missing.push(`${check.role}=${check.provider}/<unresolved>`);
        continue;
      }
      if (!ctx.modelRegistry.find(check.provider, check.id)) {
        missing.push(`${check.role}=${check.provider}/${check.id}`);
      }
    }
    return missing;
  }

  function persist(): void {
    state.updatedAt = Date.now();
    pi.appendEntry("hybrid-optimizer-state", state);
  }

  pi.on("session_start", async (_event, ctx) => {
    state = restoreState(ctx);
    yamsUnavailableNotified = false;
    rlmSessionId = `pi-${Date.now().toString(36)}`;
    rlmTurnCounter = 0;
    rlmLastMemoryHints = [];
    rlmUnavailableNotified = false;
    rlmDcsEnriched = false;
    dcsEnrichmentText = null;
    const configuredContextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : null;
    const primaryModelId = resolvePrimaryModelId(ctx);
    const contextWindowOverride = parsePositiveInt(process.env.PI_HYBRID_CONTEXT_WINDOW_OVERRIDE, 0);
    effectiveContextWindow = contextWindowOverride > 0
      ? contextWindowOverride
      : await fetchLoadedContextWindow(ctx.model?.id || "");
    setStatus(ctx);
    const missingModels = auditModelAvailability(ctx);
    const memoryMode = YAMS_ENABLED ? "yams:on" : "yams:off";
    const rlmMode = RLM_ENABLED ? "rlm:on" : "rlm:off";
    const activeProvider = ENV_OPTIMIZER_PROVIDER || resolveActiveProvider(ctx);
    const sessionSc = getSidecarConfig(activeProvider);
    const rlmExtractorModelId = ENV_RLM_EXTRACTOR_MODEL || sessionSc.rlmExtractor;
    const rlmExtractorInfo = RLM_ENABLED && RLM_EXTRACTOR_MODE === "model"
      ? `rlm-extractor:model(${rlmExtractorModelId})`
      : "rlm-extractor:heuristic";
    const dcsMode = RLM_DCS_SESSION_ENRICHMENT ? "dcs:on" : "dcs:off";
    trace("session_start", {
      optimizerModel: state.optimizerModel,
      primaryModel: primaryModelId || null,
      activeProvider,
      configuredContextWindow,
      effectiveContextWindow,
      memoryMode,
      rlmMode,
      rlmExtractorMode: RLM_EXTRACTOR_MODE,
      rlmExtractorModel: RLM_EXTRACTOR_MODE === "model" ? rlmExtractorModelId : null,
      rlmSessionId,
      dcsSessionEnrichment: RLM_DCS_SESSION_ENRICHMENT,
      optimizations: state.optimizations,
      optimizerAttempts: state.optimizerAttempts,
      optimizerSuccesses: state.optimizerSuccesses,
      optimizerFallbacks: state.optimizerFallbacks,
      missingModels,
    });
    notify(ctx, `Hybrid optimizer active (${state.optimizerModel}, ${memoryMode}, ${rlmMode}, ${rlmExtractorInfo}, ${dcsMode}).`);
    if (missingModels.length > 0) {
      notify(
        ctx,
        `Hybrid optimizer model check: missing ${missingModels.join(" | ")}. Fallbacks will be used.`,
        "warning"
      );
    }
    if (
      configuredContextWindow &&
      effectiveContextWindow &&
      effectiveContextWindow > 0 &&
      effectiveContextWindow < configuredContextWindow
    ) {
      // Sanity floor: if LM Studio reports a context window < 10% of configured,
      // override to configured value. This catches the n_ctx=4096 bug in LM Studio
      // where loaded_context_length doesn't reflect the actual model capability.
      if (effectiveContextWindow < configuredContextWindow * 0.1) {
        trace("context_window_override", {
          reason: "loaded_value_suspiciously_low",
          loaded: effectiveContextWindow,
          configured: configuredContextWindow,
          using: configuredContextWindow,
        });
        notify(
          ctx,
          `Context window ${effectiveContextWindow.toLocaleString()} << configured ${configuredContextWindow.toLocaleString()}; overriding to configured value.`,
          "warning"
        );
        effectiveContextWindow = configuredContextWindow;
      } else {
        notify(
          ctx,
          `Hybrid context mismatch: configured=${configuredContextWindow.toLocaleString()} loaded=${effectiveContextWindow.toLocaleString()} (using loaded limit).`,
          "warning"
        );
      }
    }
    // Scale context thresholds proportionally for the effective context window.
    // This ensures tier boundaries, compaction triggers, and budget warnings
    // remain sensible regardless of which model is loaded.
    if (effectiveContextWindow && effectiveContextWindow > 0) {
      scaleContextThresholds(effectiveContextWindow);
    }
  });

  // RLM: Extract and store memory chunks before compaction evicts messages
  pi.on("session_before_compact", async (event, ctx) => {
    if (!RLM_ENABLED) return; // Don't interfere with compaction-guard

    const prep = (event as any).preparation;
    const messages = prep?.messagesToSummarize;
    if (!Array.isArray(messages) || messages.length === 0) return;

    rlmTurnCounter += 1;

    let chunks: RlmChunk[];
    let extractionSource: "model" | "heuristic" | "model-fallback" = "heuristic";

    if (RLM_EXTRACTOR_MODE === "model") {
      const modelChunks = await extractMemoryChunksWithModel(ctx, messages, state);
      if (modelChunks !== null) {
        chunks = modelChunks;
        extractionSource = "model";
      } else {
        // Model failed/unavailable, fall back to heuristic
        chunks = extractMemoryChunks(messages, state);
        extractionSource = "model-fallback";
        trace("rlm_extractor_fallback", { reason: "model_returned_null", turnNumber: rlmTurnCounter });
      }
    } else {
      chunks = extractMemoryChunks(messages, state);
    }

    if (chunks.length === 0) {
      trace("rlm_extraction", {
        chunkCount: 0,
        messagesProcessed: messages.length,
        turnNumber: rlmTurnCounter,
        extractionSource,
      });
      return;
    }

    trace("rlm_extraction", {
      chunkCount: chunks.length,
      messagesProcessed: messages.length,
      turnNumber: rlmTurnCounter,
      chunkTypes: chunks.map((c) => c.type),
      extractionSource,
    });
    notify(ctx, `RLM: extracting ${chunks.length} memory chunks (${extractionSource}) from ${messages.length} evicted messages.`);

    // Fire-and-forget: store in background, don't block compaction
    storeMemoryChunks(pi, chunks, rlmSessionId, rlmTurnCounter, state.objective).then(
      (result) => {
        trace("rlm_store_complete", { ...result, turnNumber: rlmTurnCounter });
        if (result.stored > 0) {
          notify(ctx, `RLM: stored ${result.stored} memory chunks in YAMS (session ${rlmSessionId}).`);
        }
        if (result.failed > 0) {
          notify(ctx, `RLM: ${result.failed} chunk(s) failed to store.`, "warning");
        }
      },
      (error) => {
        trace("rlm_store_error", { error: String(error), turnNumber: rlmTurnCounter });
      }
    );

    // Return undefined — compaction-guard handles actual compaction behavior
  });

  pi.registerCommand("hybrid", {
    description: "Show hybrid optimizer status",
    handler: async (_args, ctx) => {
      const summary = [
        `profile=${state.lastProfile}`,
        `mode=${state.lastMode}`,
        `source=${state.lastOptimizationSource}`,
        `optimizations=${state.optimizations}`,
        `attempts=${state.optimizerAttempts}`,
        `successes=${state.optimizerSuccesses}`,
        `fallbacks=${state.optimizerFallbacks}`,
        `failures=${state.failures}`,
        `optimizer=${state.optimizerModel}`,
        `cw=${effectiveContextWindow ?? ctx.model?.contextWindow ?? "unknown"}`,
        `hints=${state.memoryHints.length}`,
        `looseParse=${ALLOW_LOOSE_PARSE ? "on" : "off"}`,
        `forward=${FORWARD_OPTIMIZED_MESSAGE ? "on" : "off"}`,
        `lastPromptPair=${state.lastOriginalPrompt && state.lastOptimizedPrompt ? "yes" : "no"}`,
      ].join(" | ");
      notify(ctx, `Hybrid status: ${summary}`);
    },
  });

  pi.registerCommand("hybrid-last", {
    description: "Show last original and optimized prompts",
    handler: async (_args, ctx) => {
      notify(ctx, `Hybrid prompt pair:\n${formatPromptPair(state)}`);
    },
  });

  pi.registerCommand("hybrid-audit", {
    description: "Show optimizer flow and guardrail settings",
    handler: async (_args, ctx) => {
      const details = [
        `profileRouter=${PROFILE_EMBED_ROUTER ? "on" : "off"}`,
        `yams=${YAMS_ENABLED ? "on" : "off"}`,
        `allowLooseParse=${ALLOW_LOOSE_PARSE ? "on" : "off"}`,
        `forwardOptimizedMessage=${FORWARD_OPTIMIZED_MESSAGE ? "on" : "off"}`,
        `forwardPromptMaxChars=${FORWARD_PROMPT_MAX_CHARS}`,
      ].join(" | ");
      notify(ctx, `Hybrid audit: ${details}`);
    },
  });

  pi.registerCommand("hybrid-proof-forward", {
    description: "Probe forwarded optimized prompt formatting",
    handler: async (_args, ctx) => {
      const probePrompt = "Compare novelty claims against SOTA and ground findings in local sources first.";
      const probeResult = buildFallback(probePrompt);
      const forwarded = buildForwardedPrompt(probePrompt, probeResult);
      trace("optimizer_forwarded_prompt", {
        chars: forwarded.length,
        profile: "general",
        source: "probe",
        probe: true,
      });
      notify(ctx, `Hybrid forward proof:\n${truncate(forwarded, 800)}`);
    },
  });

  pi.registerCommand("hybrid-reset", {
    description: "Clear hybrid optimizer carry state",
    handler: async (_args, ctx) => {
      state.objective = "";
      state.carry = [];
      state.memoryHints = [];
      state.lastOriginalPrompt = "";
      state.lastOptimizedPrompt = "";
      state.lastMode = "fast";
      state.lastProfile = "general";
      state.lastOptimizationSource = "fallback";
      state.optimizerAttempts = 0;
      state.optimizerSuccesses = 0;
      state.optimizerFallbacks = 0;
      persist();
      setStatus(ctx);
      trace("state_reset");
      notify(ctx, "Hybrid optimizer state reset.");
    },
  });

  pi.registerCommand("hybrid-hints", {
    description: "Show current YAMS memory hints",
    handler: async (_args, ctx) => {
      if (state.memoryHints.length === 0) {
        notify(ctx, "Hybrid hints: none loaded for current state.");
        return;
      }

      const lines = state.memoryHints
        .slice(0, MAX_HINTS_IN_PROMPT)
        .map((hint, i) => `${i + 1}) ${hint.path} | ${truncate(hint.snippet, 120)}`)
        .join("\n");
      notify(ctx, `Hybrid hints:\n${lines}`);
    },
  });

  pi.registerCommand("rlm", {
    description: "Show RLM (Retrieval Long Memory) status and recalled chunks",
    handler: async (_args, ctx) => {
      const status = [
        `RLM enabled: ${RLM_ENABLED}`,
        `Session ID: ${rlmSessionId}`,
        `Turn counter: ${rlmTurnCounter}`,
        `Collection: ${RLM_COLLECTION}`,
        `Retrieved chunks: ${rlmLastMemoryHints.length}`,
      ];
      if (rlmLastMemoryHints.length > 0) {
        status.push("Recalled session memory:");
        for (let i = 0; i < rlmLastMemoryHints.length; i += 1) {
          const hint = rlmLastMemoryHints[i];
          status.push(`  ${i + 1}) [${hint.chunkType}] (score ${hint.score.toFixed(3)}): ${truncate(hint.snippet, 200)}`);
        }
      }
      notify(ctx, status.join("\n"));
    },
  });

  pi.registerCommand("rlm-deep-recall", {
    description: "Run DCS deep multi-hop recall on a topic (usage: /rlm-deep-recall <topic>)",
    handler: async (args, ctx) => {
      const topic = (args || "").trim();
      if (!topic) {
        notify(ctx, "Usage: /rlm-deep-recall <topic>\nExample: /rlm-deep-recall compaction bug timeline", "warning");
        return;
      }

      notify(ctx, `Starting DCS deep recall on: ${truncate(topic, 120)}...`);
      const result = await dcsDeepRecall(topic);
      if (result) {
        notify(ctx, `[DCS Deep Recall — ${truncate(topic, 80)}]\n${result}`);
      } else {
        notify(ctx, `DCS deep recall returned no results for: ${truncate(topic, 120)}`, "warning");
      }
    },
  });

  pi.registerCommand("hybrid-proof", {
    description: "Probe optimizer model availability",
    handler: async (_args, ctx) => {
      const probe = "Create a concise coding execution brief for adding tests to a TypeScript extension.";
      state.optimizerAttempts += 1;
      trace("optimizer_attempt", {
        promptChars: probe.length,
        attempt: state.optimizerAttempts,
        configuredModel: ENV_OPTIMIZER_MODEL || getSidecarConfig(resolveActiveProvider(ctx)).optimizer,
        probe: true,
      });
      const optimized = await optimizeWithModel(ctx, probe, state, "general");
      if (!optimized) {
        state.optimizerFallbacks += 1;
        state.lastOptimizationSource = "fallback";
        trace("optimizer_fallback", {
          reason: "proof_failed",
          attempt: state.optimizerAttempts,
          probe: true,
        });
        persist();
        notify(ctx, "Hybrid proof: optimizer model call failed or returned invalid JSON.", "warning");
        return;
      }

      state.optimizerModel = optimized.modelId;
      state.lastProfile = "general";
      state.optimizerSuccesses += 1;
      state.lastOptimizationSource = "model";
      trace("optimizer_success", {
        modelId: optimized.modelId,
        confidence: optimized.result.confidence,
        mode: optimized.result.mode,
        attempt: state.optimizerAttempts,
        probe: true,
      });
      persist();
      setStatus(ctx);
      notify(ctx, `Hybrid proof: optimizer model OK (${optimized.modelId}).`);
    },
  });

  pi.registerCommand("hybrid-proof-research", {
    description: "Probe research optimizer model availability",
    handler: async (_args, ctx) => {
      const probe = "Create a literature review plan with citation-grounded workflow for P4 INT telemetry and GNN IDS systems.";
      state.optimizerAttempts += 1;
      trace("optimizer_attempt", {
        promptChars: probe.length,
        attempt: state.optimizerAttempts,
        configuredModel: ENV_RESEARCH_OPTIMIZER_MODEL || getSidecarConfig(resolveActiveProvider(ctx)).researchOptimizer,
        probe: true,
        profile: "research",
      });
      const optimized = await optimizeWithModel(ctx, probe, state, "research");
      if (!optimized) {
        state.optimizerFallbacks += 1;
        state.lastOptimizationSource = "fallback";
        state.lastProfile = "research";
        trace("optimizer_fallback", {
          reason: "proof_failed",
          attempt: state.optimizerAttempts,
          probe: true,
          profile: "research",
        });
        persist();
        notify(ctx, "Hybrid research proof: optimizer call failed or returned invalid JSON.", "warning");
        return;
      }

      state.optimizerModel = optimized.modelId;
      state.optimizerSuccesses += 1;
      state.lastOptimizationSource = "model";
      state.lastProfile = "research";
      trace("optimizer_success", {
        modelId: optimized.modelId,
        confidence: optimized.result.confidence,
        mode: optimized.result.mode,
        attempt: state.optimizerAttempts,
        probe: true,
        profile: "research",
      });
      persist();
      setStatus(ctx);
      notify(ctx, `Hybrid research proof: optimizer model OK (${optimized.modelId}).`);
    },
  });

  pi.registerCommand("oracle-proof", {
    description: "Probe oracle review model availability",
    handler: async (_args, ctx) => {
      const probePrompt = "Review a research literature plan for P4 INT and GNN IDS for citation quality.";
      const probeResult: OptimizerResult = {
        mode: "deep",
        optimizedPrompt: probePrompt,
        executionBrief: "Gather evidence from code->papers->docs and verify citations.",
        objective: "Validate literature review execution plan quality.",
        carry: [],
        confidence: 0.7,
      };

      const oracle = await runOracleReview(ctx, probePrompt, probeResult, "research");
      if (!oracle) {
        notify(ctx, "Oracle proof: review model unavailable or parse failed.", "warning");
        return;
      }

      notify(
        ctx,
        `Oracle proof: ${oracle.modelId} verdict=${oracle.review.verdict} confidence=${oracle.review.confidence.toFixed(2)}`
      );
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const prompt = (event.prompt || "").trim();

    // For watchdog retry/cron prompts: skip full optimization but still inject
    // context budget steering so the LLM is aware of context pressure.
    if (shouldSkipPrompt(prompt)) {
      const configuredCw = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : 128000;
      const usageTokens = ctx.getContextUsage()?.tokens ?? null;
      const steering = buildContextSteering(usageTokens, configuredCw, effectiveContextWindow);
      if (steering && usageTokens !== null && usageTokens >= CONTEXT_BUDGET_STEER_TOKENS) {
        const budgetMsg = [
          `[CONTEXT BUDGET WARNING: ${usageTokens.toLocaleString()} tokens used (${Math.round(steering.usageRatio * 100)}% of ${steering.contextWindow.toLocaleString()}).`,
          YAMS_FIRST_STEERING,
          `This is a retry/recovery prompt. Keep output minimal, complete only the immediate objective, avoid broad exploration.]`,
        ].join("\n");
        trace("skip_prompt_budget_steering", {
          tokens: usageTokens,
          pressure: steering.pressure,
          prompt: prompt.slice(0, 100),
        });
        const response: any = {
          systemPrompt: [event.systemPrompt, budgetMsg].join("\n\n"),
        };
        if (usageTokens >= CONTEXT_BUDGET_WARN_TOKENS) {
          response.message = {
            customType: "hybrid-retry-budget-warning",
            content: budgetMsg,
            display: false,
          };
        }
        return response;
      }
      return;
    }

    const signal = (event as any).signal as AbortSignal | undefined;
    const cleanedPrompt = stripWrapperBlocks(prompt);
    const effectivePrompt = cleanedPrompt || prompt;
    let profile = detectProfile(effectivePrompt);
    const bypassOptimizer = shouldBypassOptimizer(effectivePrompt);
    let preloadedHints: Array<{ path: string; snippet: string; score: number }> | null = null;
    const configuredContextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : 128000;
    const usageTokens = ctx.getContextUsage()?.tokens ?? null;
    const contextSteering = buildContextSteering(usageTokens, configuredContextWindow, effectiveContextWindow);
    if (contextSteering) {
      trace("context_steering", {
        usageTokens: contextSteering.usageTokens,
        contextWindow: contextSteering.contextWindow,
        availableTokens: contextSteering.availableTokens,
        usageRatio: contextSteering.usageRatio,
        pressure: contextSteering.pressure,
      });
    }

    // --- Pre-flight context budget: inject YAMS-first steering when context is heavy ---
    let contextBudgetMessage: string | null = null;
    if (contextSteering) {
      const tokens = contextSteering.usageTokens;
      const hasDirectoryPaths = /(?:@\.\/|\.\/\S+\/|~\/\S+\/)/.test(effectivePrompt);

      if (tokens >= CONTEXT_BUDGET_WARN_TOKENS) {
        contextBudgetMessage = [
          `[CONTEXT BUDGET WARNING: ${tokens.toLocaleString()} tokens used (${Math.round(contextSteering.usageRatio * 100)}% of ${contextSteering.contextWindow.toLocaleString()}).`,
          YAMS_FIRST_STEERING,
          `CRITICAL: Context window is nearly full. Complete only the highest-priority objective. Keep output minimal.]`,
        ].join("\n");
        trace("context_budget_warning", { tokens, threshold: CONTEXT_BUDGET_WARN_TOKENS, level: "critical", hasDirectoryPaths });
      } else if (tokens >= CONTEXT_BUDGET_STEER_TOKENS && hasDirectoryPaths) {
        contextBudgetMessage = [
          `[CONTEXT BUDGET NOTICE: ${tokens.toLocaleString()} tokens used. Directory paths detected in prompt.`,
          YAMS_FIRST_STEERING,
          `Avoid expanding entire directories -- use YAMS to find relevant files first.]`,
        ].join("\n");
        trace("context_budget_warning", { tokens, threshold: CONTEXT_BUDGET_STEER_TOKENS, level: "steer", hasDirectoryPaths });
      } else if (hasDirectoryPaths) {
        contextBudgetMessage = [
          `[SEARCH GUIDANCE: Directory paths detected in prompt.`,
          `Prefer using YAMS search first to find relevant files, then read specific files/sections. This is more efficient than broad directory listings.]`,
        ].join("\n");
        trace("context_budget_guidance", { tokens, hasDirectoryPaths });
      }
    }

    if (PROFILE_EMBED_ROUTER && YAMS_ENABLED && !signal?.aborted) {
      try {
        const routingHints = await fetchYamsHints(pi, effectivePrompt, state, signal);
        preloadedHints = routingHints;
        if (routingHints.length > 0) {
          const inferredResearch = inferResearchFromHints(routingHints);
          if (inferredResearch) profile = "research";
          trace("profile_router", {
            method: "yams_hints",
            inferredResearch,
            hintCount: routingHints.length,
            profile,
          });
        } else {
          trace("profile_router", { method: "yams_hints", inferredResearch: false, hintCount: 0, profile });
        }
      } catch {
        trace("profile_router", { method: "yams_hints", error: "routing_fetch_failed", profile });
      }
    }

    const msgProvider = ENV_OPTIMIZER_PROVIDER || resolveActiveProvider(ctx);
    const msgSc = getSidecarConfig(msgProvider);
    let result = buildFallback(effectivePrompt);
    let optimizerModelId = profile === "research"
      ? (ENV_RESEARCH_OPTIMIZER_MODEL || msgSc.researchOptimizer)
      : (ENV_OPTIMIZER_MODEL || msgSc.optimizer);
    let source: "model" | "fallback" = "fallback";
    let oracleReview: OracleReview | undefined;

    const shouldUseOptimizer =
      !bypassOptimizer && (effectivePrompt.length >= MIN_PROMPT_CHARS_FOR_OPTIMIZER || needsDeepMode(effectivePrompt));
    if (shouldUseOptimizer) {
      state.optimizerAttempts += 1;
      trace("optimizer_attempt", {
        promptChars: effectivePrompt.length,
        rawPromptChars: prompt.length,
        attempt: state.optimizerAttempts,
        configuredModel: optimizerModelId,
        profile,
      });
      try {
        const optimized = await optimizeWithModel(ctx, effectivePrompt, state, profile, signal, contextSteering);
        if (optimized) {
          result = optimized.result;
          optimizerModelId = optimized.modelId;
          source = "model";
          state.optimizerSuccesses += 1;
          trace("optimizer_success", {
            modelId: optimizerModelId,
            confidence: result.confidence,
            mode: result.mode,
            attempt: state.optimizerAttempts,
            profile,
          });
          unavailableNotified = false;
        } else if (!unavailableNotified) {
          state.optimizerFallbacks += 1;
          trace("optimizer_fallback", {
            reason: "model_unavailable_or_parse_failed",
            attempt: state.optimizerAttempts,
            profile,
          });
          unavailableNotified = true;
          notify(ctx, "Hybrid optimizer model unavailable, using fallback heuristics.", "warning");
        } else {
          state.optimizerFallbacks += 1;
          trace("optimizer_fallback", {
            reason: "model_unavailable_or_parse_failed",
            attempt: state.optimizerAttempts,
            profile,
          });
        }
      } catch (error) {
        state.failures += 1;
        state.optimizerFallbacks += 1;
        trace("optimizer_fallback", {
          reason: "optimizer_exception",
          attempt: state.optimizerAttempts,
          profile,
        });
        if (!signal?.aborted) {
          console.error("[hybrid-optimizer] optimization failed:", error);
        }
      }
    } else if (bypassOptimizer) {
      trace("optimizer_bypassed", {
        reason: "detected_log_or_terminated_payload",
        profile,
        promptChars: effectivePrompt.length,
        rawPromptChars: prompt.length,
      });
    } else {
      // Prompt is too short for optimization and does not need deep mode.
      trace("optimizer_skipped", {
        reason: "short_prompt",
        promptChars: effectivePrompt.length,
        rawPromptChars: prompt.length,
        minChars: MIN_PROMPT_CHARS_FOR_OPTIMIZER,
        needsDeep: false,
        profile,
      });
    }

    if (!bypassOptimizer && shouldRunOracle(effectivePrompt, result, profile) && !signal?.aborted) {
      const oracle = await runOracleReview(ctx, effectivePrompt, result, profile, signal);
      if (oracle) {
        oracleReview = oracle.review;
      }
    }

    if (YAMS_ENABLED && !signal?.aborted) {
      try {
        const hints = preloadedHints ?? (await fetchYamsHints(pi, effectivePrompt, state, signal));
        if (hints.length > 0) {
          state.memoryHints = hints;
          trace("yams_hints", { count: hints.length });
          yamsUnavailableNotified = false;
        } else {
          state.memoryHints = [];
          trace("yams_hints", { count: 0 });
        }
      } catch (error) {
        trace("yams_hints", { count: 0, error: "fetch_failed" });
        if (!yamsUnavailableNotified) {
          yamsUnavailableNotified = true;
          notify(ctx, "YAMS hints unavailable, continuing without external memory.", "warning");
        }
        if (!signal?.aborted) {
          console.error("[hybrid-optimizer] yams hint retrieval failed:", error);
        }
      }
    }

    // RLM: Retrieve relevant session memory chunks
    if (RLM_ENABLED && !signal?.aborted) {
      try {
        const rlmHints = await fetchRlmMemory(pi, effectivePrompt, state, rlmSessionId, signal);
        if (rlmHints.length > 0) {
          rlmLastMemoryHints = rlmHints;
          trace("rlm_retrieve", { count: rlmHints.length, topScore: rlmHints[0]?.score });
          rlmUnavailableNotified = false;
        } else {
          rlmLastMemoryHints = [];
          trace("rlm_retrieve", { count: 0 });
        }
      } catch (error) {
        trace("rlm_retrieve", { count: 0, error: "fetch_failed" });
        if (!rlmUnavailableNotified) {
          rlmUnavailableNotified = true;
          notify(ctx, "RLM session memory unavailable, continuing without recalled context.", "warning");
        }
        if (!signal?.aborted) {
          console.error("[hybrid-optimizer] RLM retrieval failed:", error);
        }
      }
    }

    // DCS session enrichment: on first turn only, if RLM returned memories,
    // run DCS multi-hop retrieval to synthesize a richer context briefing.
    if (
      RLM_DCS_SESSION_ENRICHMENT &&
      !rlmDcsEnriched &&
      rlmLastMemoryHints.length > 0 &&
      !signal?.aborted
    ) {
      rlmDcsEnriched = true; // set immediately to prevent re-entry
      try {
        const enrichment = await enrichSessionWithDcs(
          rlmLastMemoryHints.map((h) => ({ snippet: h.snippet, score: h.score }))
        );
        if (enrichment) {
          dcsEnrichmentText = enrichment;
          notify(ctx, `DCS session enrichment complete (${enrichment.length} chars).`);
        }
      } catch (error) {
        trace("dcs_session_enrichment_error", { error: String(error).slice(0, 200) });
        if (!signal?.aborted) {
          console.error("[hybrid-optimizer] DCS session enrichment failed:", error);
        }
      }
    }

    state.lastMode = result.mode;
    state.lastProfile = profile;
    state.lastOptimizationSource = source;
    state.objective = result.objective || state.objective || truncate(effectivePrompt, 240);
    state.carry = normalizeLines([...state.carry, ...result.carry]).slice(-MAX_CARRY_ITEMS);
    state.lastOriginalPrompt = truncate(normalizePromptText(effectivePrompt), PROMPT_STATE_CHARS);
    state.lastOptimizedPrompt = truncate(normalizePromptText(result.optimizedPrompt), PROMPT_STATE_CHARS);
    state.optimizerModel = optimizerModelId;
    state.optimizations += 1;

    trace("prompt_pair", {
      originalChars: state.lastOriginalPrompt.length,
      optimizedChars: state.lastOptimizedPrompt.length,
      profile,
      source,
    });
    trace("optimizer_apply", {
      profile,
      mode: result.mode,
      source,
      forwarded: FORWARD_OPTIMIZED_MESSAGE,
      contextPressure: contextSteering?.pressure || "unknown",
    });

    if (SHOW_PROMPT_PAIR) {
      notify(ctx, `Hybrid prompt pair:\n${formatPromptPair(state)}`);
    }

    persist();

    if (AUTO_THINKING) {
      pi.setThinkingLevel(result.mode === "deep" ? "medium" : "low");
    }

    setStatus(ctx);
    const systemPromptParts = [
      event.systemPrompt,
      buildSystemPromptPatch(state, result, profile, oracleReview, contextSteering, rlmLastMemoryHints),
    ];

    // Append DCS enrichment briefing if available (first turn only)
    if (dcsEnrichmentText) {
      systemPromptParts.push(
        `[DCS Context Briefing — synthesized from session memories and project knowledge]\n${dcsEnrichmentText}`
      );
      // Clear after first injection to avoid re-injecting on subsequent turns
      dcsEnrichmentText = null;
    }

    // Append YAMS-first steering to system prompt when context budget demands it
    if (contextBudgetMessage && contextSteering &&
        (contextSteering.pressure === "high" || contextSteering.pressure === "critical")) {
      systemPromptParts.push(contextBudgetMessage);
    }

    const response: any = {
      systemPrompt: systemPromptParts.join("\n\n"),
    };

    if (FORWARD_OPTIMIZED_MESSAGE) {
      let forwarded = buildForwardedPrompt(effectivePrompt, result);
      if (contextBudgetMessage) {
        forwarded = `${forwarded}\n\n${contextBudgetMessage}`;
      }
      response.message = {
        customType: "hybrid-forwarded-prompt",
        content: forwarded,
        display: false,
      };
      trace("optimizer_forwarded_prompt", {
        chars: forwarded.length,
        profile,
        source,
        hasContextBudgetWarning: !!contextBudgetMessage,
      });
    } else if (contextBudgetMessage) {
      response.message = {
        customType: "hybrid-context-budget",
        content: contextBudgetMessage,
        display: false,
      };
    }

    return response;
  });

  pi.on("context", async (event, ctx) => {
    // -----------------------------------------------------------------------
    // Determine current token tier for progressive context management.
    // Tier 0 (< 64K):  Standard structural dedup (original behavior)
    // Tier 1 (64K–128K): Tighter caps — tool→4K, old assistant→600, strip ALL
    //                     thinking, keep last 4 assistant messages
    // Tier 2 (128K–192K): Tier 1 + replace old messages with YAMS-retrieved chunks
    // Tier 3 (> 192K): Tier 2 + keep only last 8 messages verbatim
    // -----------------------------------------------------------------------
    const usage = ctx.getContextUsage();
    const tokens = usage?.tokens ?? 0;
    const tier = tokens >= CTX_TIER3_TOKENS ? 3
      : tokens >= CTX_TIER2_TOKENS ? 2
      : tokens >= CTX_TIER1_TOKENS ? 1
      : 0;

    // Select tier-appropriate caps
    const toolOutputMaxChars = tier >= 1 ? TIER1_TOOL_OUTPUT_MAX_CHARS : TOOL_OUTPUT_MAX_CHARS;
    const capOldAssistantChars = tier >= 1 ? TIER1_CAP_OLD_ASSISTANT_TEXT_CHARS : CAP_OLD_ASSISTANT_TEXT_CHARS;
    const keepRecentAssistant = tier >= 1 ? TIER1_KEEP_RECENT_ASSISTANT_MESSAGES : KEEP_RECENT_ASSISTANT_MESSAGES;
    const stripAllThinking = tier >= 1; // Tier 0: strip only old assistant thinking; Tier 1+: strip ALL

    if (tier > 0) {
      trace("context_tier_active", { tier, tokens, toolOutputMaxChars, capOldAssistantChars, keepRecentAssistant });
    }

    // --- Tool output truncation: cap large tool results to prevent context flooding ---
    let toolTruncations = 0;
    for (const message of event.messages) {
      if ((message as any)?.role !== "toolResult" || !Array.isArray((message as any)?.content)) continue;
      const toolMsg = message as any;
      for (let j = 0; j < toolMsg.content.length; j++) {
        const block = toolMsg.content[j];
        if (block?.type === "text" && typeof block.text === "string" && block.text.length > toolOutputMaxChars) {
          const result = truncateToolOutput(block.text);
          // Re-truncate to tier-appropriate cap if needed
          let truncatedText = result.text;
          if (truncatedText.length > toolOutputMaxChars) {
            truncatedText = truncate(truncatedText, toolOutputMaxChars);
          }
          if (truncatedText !== block.text) {
            toolMsg.content[j] = { ...block, text: truncatedText };
            toolTruncations++;
            trace("tool_output_truncated", {
              toolName: toolMsg.toolName || "unknown",
              originalChars: block.text.length,
              truncatedChars: truncatedText.length,
              tier,
            });
          }
        }
      }
    }
    if (toolTruncations > 0) {
      trace("tool_output_truncation_pass", { count: toolTruncations, tier });
    }

    const messageTexts = event.messages.map((message: any) => extractText(message?.content).trim());

    let toolsSeen = 0;
    let latestToolsIndex = -1;
    const latestSkillIndexByKey = new Map<string, number>();
    let skillsSeen = 0;
    const latestLargeByHash = new Map<string, number>();

    for (let i = 0; i < event.messages.length; i += 1) {
      const text = messageTexts[i];
      if (!text) continue;

      if (isToolsBlock(text)) {
        toolsSeen += 1;
        latestToolsIndex = i;
      }

      const skillKey = extractSkillKey(text);
      if (skillKey) {
        skillsSeen += 1;
        latestSkillIndexByKey.set(skillKey, i);
      }

      if (text.length > 6000) {
        latestLargeByHash.set(hashText(text.slice(0, 4000)), i);
      }
    }

    let mutated = false;
    const keep = new Array(event.messages.length).fill(true);

    for (let i = 0; i < event.messages.length; i += 1) {
      const text = messageTexts[i];
      if (!text) continue;

      if (isToolsBlock(text) && latestToolsIndex >= 0 && i !== latestToolsIndex) {
        keep[i] = false;
        mutated = true;
        continue;
      }

      const skillKey = extractSkillKey(text);
      if (skillKey && latestSkillIndexByKey.get(skillKey) !== i) {
        keep[i] = false;
        mutated = true;
        continue;
      }

      if (text.length > 6000) {
        const key = hashText(text.slice(0, 4000));
        if (latestLargeByHash.get(key) !== i) {
          keep[i] = false;
          mutated = true;
          continue;
        }
      }
    }

    if (toolsSeen > 0 && latestToolsIndex >= 0 && !keep[latestToolsIndex]) {
      keep[latestToolsIndex] = true;
      mutated = true;
    }

    let filtered = event.messages.filter((_message: any, index: number) => keep[index]);

    // --- Tier 2+: Replace old messages with YAMS-retrieved context chunks ---
    if (tier >= 2) {
      const chunkerStats = contextChunker.stats();
      if (chunkerStats.cachedChunks > 0) {
        const beforeLen = filtered.length;
        filtered = contextChunker.buildOptimizedContext(filtered, TIER2_SEMANTIC_KEEP_LAST_N);
        const afterLen = filtered.length;
        if (afterLen !== beforeLen) {
          mutated = true;
          trace("context_chunk_retrieval_compression", {
            tier,
            beforeMessages: beforeLen,
            afterMessages: afterLen,
            cachedChunks: chunkerStats.cachedChunks,
          });
        }
      }
    }

    // --- Tier 3: Emergency — keep only last N messages verbatim ---
    if (tier >= 3 && filtered.length > TIER3_KEEP_LAST_MESSAGES) {
      const beforeLen = filtered.length;
      filtered = filtered.slice(filtered.length - TIER3_KEEP_LAST_MESSAGES);
      mutated = true;
      trace("context_tier3_emergency_trim", {
        tier,
        beforeMessages: beforeLen,
        afterMessages: filtered.length,
        keptMessages: TIER3_KEEP_LAST_MESSAGES,
      });
    }

    const assistantIndexes: number[] = [];
    for (let i = 0; i < filtered.length; i += 1) {
      if (filtered[i]?.role === "assistant") assistantIndexes.push(i);
    }
    const keepSet = new Set(assistantIndexes.slice(Math.max(0, assistantIndexes.length - keepRecentAssistant)));

    const compacted = filtered.map((message: any, index: number) => {
      if (message?.role !== "assistant" || !Array.isArray(message?.content)) return message;
      // Tier 1+: strip thinking from ALL assistant messages (including recent)
      // Tier 0: only strip thinking from old assistant messages (original behavior)
      const isRecent = keepSet.has(index);
      if (!stripAllThinking && isRecent) return message;

      let changed = false;
      const nextContent = message.content
        .filter((block: any) => {
          if (block?.type === "thinking") {
            // Tier 0: strip only from old messages; Tier 1+: strip from all
            if (stripAllThinking || !isRecent) {
              changed = true;
              return false;
            }
          }
          return true;
        })
        .map((block: any) => {
          // Cap text in old (non-recent) messages
          if (!isRecent && block?.type === "text" && typeof block.text === "string" && block.text.length > capOldAssistantChars) {
            changed = true;
            return { ...block, text: truncate(block.text, capOldAssistantChars) };
          }
          return block;
        });

      if (!changed) return message;
      mutated = true;
      return { ...message, content: nextContent };
    });

    if (mutated) {
      const toolsKept = filtered.filter((message: any) => isToolsBlock(extractText(message?.content).trim())).length;
      const skillsKept = filtered.filter((message: any) => extractSkillKey(extractText(message?.content).trim()) !== null).length;
      trace("context_prune", {
        totalBefore: event.messages.length,
        totalAfter: filtered.length,
        toolsSeen,
        toolsKept,
        skillsSeen,
        skillsKept,
        tier,
        tokens,
      });
    }

    if (mutated) {
      return { messages: compacted };
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    // Sweep stale temp files from deferred YAMS ingest cleanup.
    rlmTempFileManager.sweep();

    if (compactionInFlight) return;

    // Don't attempt compaction if the turn ended abnormally (model error/termination)
    // UNLESS context usage is critically high. Skipping compaction on abnormal stops
    // while context keeps growing is a death spiral — each retry bloats context further,
    // gets aborted again, skips compaction again, etc.
    const turnMessage = (_event as any).message;
    const stopReason = turnMessage?.stopReason;
    const CRITICAL_CONTEXT_RATIO = 0.80;
    if (typeof stopReason === "string") {
      const lower = stopReason.trim().toLowerCase();
      const abnormal = ["terminated", "abort", "aborted", "cancel", "cancelled", "interrupted", "error"];
      if (abnormal.some((token) => lower.includes(token))) {
        // Check if context usage is critical before skipping.
        const earlyUsage = ctx.getContextUsage();
        const configuredCw = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : 128000;
        const cw = effectiveContextWindow && effectiveContextWindow > 0 ? effectiveContextWindow : configuredCw;
        const usageRatio = earlyUsage && earlyUsage.tokens !== null ? earlyUsage.tokens / cw : 0;
        if (usageRatio < CRITICAL_CONTEXT_RATIO) {
          trace("compaction_skipped", { reason: "abnormal_stop", stopReason, usageRatio });
          return;
        }
        // Critical context usage on abnormal stop — force compaction below.
        trace("compaction_forced_abnormal", {
          reason: "critical_context_on_abnormal_stop",
          stopReason,
          usageRatio,
          tokens: earlyUsage?.tokens,
          contextWindow: cw,
        });
        notify(
          ctx,
          `Context critically high (${Math.round(usageRatio * 100)}%) after abnormal stop — forcing compaction.`,
          "warning"
        );
      }
    }

    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null) return;
    const now = Date.now();
    if (now - lastCompactionAt < COMPACTION_COOLDOWN_MS) return;

    const configuredContextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : 128000;
    const contextWindow = effectiveContextWindow && effectiveContextWindow > 0 ? effectiveContextWindow : configuredContextWindow;
    const uncappedThreshold = Math.max(Math.floor(contextWindow * COMPACTION_RATIO), COMPACTION_MIN_TOKENS);
    const safetyCap = Math.max(1, contextWindow - COMPACTION_SAFETY_HEADROOM_TOKENS);
    const threshold = Math.min(uncappedThreshold, safetyCap);
    if (usage.tokens < threshold) return;

    compactionInFlight = true;
    lastCompactionAt = now;
    trace("compaction_trigger", {
      tokens: usage.tokens,
      threshold,
      contextWindow,
      configuredContextWindow,
      ratio: COMPACTION_RATIO,
      safetyCap,
      safetyHeadroomTokens: COMPACTION_SAFETY_HEADROOM_TOKENS,
    });
    notify(
      ctx,
      `Hybrid compaction triggered at ${usage.tokens.toLocaleString()} tokens (${Math.round(COMPACTION_RATIO * 100)}%, headroom ${COMPACTION_SAFETY_HEADROOM_TOKENS.toLocaleString()} tokens).`
    );

    ctx.compact({
      customInstructions:
        "Prefer preserving current objective, unresolved blockers, file paths, and pending decisions. Remove repeated skill/tool boilerplate.",
      onComplete: () => {
        const elapsed = Date.now() - compactionStartedAt;
        compactionInFlight = false;
        stopCompactionPoll();
        contextChunker.invalidate(); // Compaction resets message history — cached chunks are stale
        trace("compaction_complete", { elapsedMs: elapsed });
        notify(ctx, `Hybrid compaction complete (${Math.round(elapsed / 1000)}s).`);
      },
      onError: (error) => {
        const elapsed = Date.now() - compactionStartedAt;
        compactionInFlight = false;
        stopCompactionPoll();
        trace("compaction_error", { message: error.message, elapsedMs: elapsed });
        notify(ctx, `Hybrid compaction failed after ${Math.round(elapsed / 1000)}s: ${error.message}`, "error");
      },
    });

    // Poll-based progress monitoring instead of a fixed timeout.
    // The poll never prematurely resets compactionInFlight — only the real
    // onComplete/onError callbacks above do that.  After COMPACTION_STALL_THRESHOLD_MS
    // of total silence the poll clears the flag as a last-resort safety valve.
    compactionStartedAt = Date.now();
    startCompactionPoll(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopCompactionPoll();
    compactionInFlight = false;
    effectiveContextWindow = null;
    // Flush all deferred temp files — session is ending, daemon has had time to ingest.
    rlmTempFileManager.flushAll();
    setStatus(ctx);
  });
}
