import fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

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

const PRIMARY_MODEL = process.env.PI_PRIMARY_MODEL || "unsloth/qwen3.5-35b-a3b";
const DEFAULT_OPTIMIZER_PROVIDER = process.env.PI_OPTIMIZER_PROVIDER || "lmstudio";
const DEFAULT_OPTIMIZER_MODEL = process.env.PI_OPTIMIZER_MODEL || PRIMARY_MODEL;
const FALLBACK_OPTIMIZER_MODEL = "mistralai/ministral-3-14b-reasoning";
const RESEARCH_OPTIMIZER_MODEL = process.env.PI_OPTIMIZER_RESEARCH_MODEL || PRIMARY_MODEL;
const ORACLE_ENABLED = parseBoolean(process.env.PI_ORACLE_ENABLED, true);
const ORACLE_PROVIDER = process.env.PI_ORACLE_PROVIDER || "lmstudio";
const ORACLE_MODEL = process.env.PI_ORACLE_MODEL || PRIMARY_MODEL;
const ORACLE_MAX_TOKENS = parsePositiveInt(process.env.PI_ORACLE_MAX_TOKENS, 160);
const ORACLE_TIMEOUT_MS = parsePositiveInt(process.env.PI_ORACLE_TIMEOUT_MS, 12000);

const MIN_PROMPT_CHARS_FOR_OPTIMIZER = parsePositiveInt(process.env.PI_OPTIMIZER_MIN_CHARS, 120);
const OPTIMIZER_MAX_TOKENS = parsePositiveInt(process.env.PI_OPTIMIZER_MAX_TOKENS, 700);
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
const LMSTUDIO_MODELS_URL = process.env.PI_LMSTUDIO_MODELS_URL || "http://localhost:1234/api/v0/models";
const LMSTUDIO_MODELS_TIMEOUT_MS = parsePositiveInt(process.env.PI_LMSTUDIO_MODELS_TIMEOUT_MS, 2500);

const COMPACTION_RATIO = parseRatio(process.env.PI_HYBRID_COMPACTION_RATIO, 0.85);
const COMPACTION_MIN_TOKENS = parsePositiveInt(process.env.PI_HYBRID_COMPACTION_MIN_TOKENS, 180000);
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
const RLM_MAX_HINTS_IN_PROMPT = 3;
const RLM_MAX_HINT_SNIPPET_CHARS = 400;

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

async function fetchLoadedContextWindow(modelId: string): Promise<number | null> {
  if (!modelId) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LMSTUDIO_MODELS_TIMEOUT_MS);
  try {
    const response = await fetch(LMSTUDIO_MODELS_URL, { signal: controller.signal });
    if (!response.ok) return null;
    const data = (await response.json()) as any;
    const rows = Array.isArray(data?.data) ? data.data : [];
    const row = rows.find((item: any) => item && typeof item.id === "string" && item.id === modelId);
    if (!row) return null;
    const loaded = Number(row.loaded_context_length);
    if (!Number.isFinite(loaded) || loaded <= 0) return null;
    return Math.floor(loaded);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeLines(lines: string[]): string[] {
  return lines
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
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
  const cleaned = extractJsonObject(
    raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "")
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
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
  const candidates = normalizeLines([
    ORACLE_MODEL,
    PRIMARY_MODEL,
    "mistralai/ministral-3-14b-reasoning",
    "unsloth/qwen3.5-27b",
  ]);

  for (const id of candidates) {
    const model = ctx.modelRegistry.find(ORACLE_PROVIDER, id);
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
    trace("oracle_unavailable", { reason: "model_not_found", provider: ORACLE_PROVIDER });
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
    const response = await withTimeout(
      complete(
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
        { apiKey, maxTokens: ORACLE_MAX_TOKENS, signal }
      ),
      ORACLE_TIMEOUT_MS
    );

    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();

    const parsed = parseOracleJson(text);
    if (!parsed) {
      trace("oracle_parse_failed", { modelId: model.id, responseChars: text.length });
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
      optimizerModel: typeof data?.optimizerModel === "string" ? data.optimizerModel : DEFAULT_OPTIMIZER_MODEL,
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
    optimizerModel: DEFAULT_OPTIMIZER_MODEL,
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
  const preferred =
    profile === "research"
      ? normalizeLines([
          RESEARCH_OPTIMIZER_MODEL,
          PRIMARY_MODEL,
          "qwen3.5-27b-heretic",
          "mlx-community/qwen3.5-27b",
          DEFAULT_OPTIMIZER_MODEL,
          FALLBACK_OPTIMIZER_MODEL,
        ])
      : normalizeLines([DEFAULT_OPTIMIZER_MODEL, PRIMARY_MODEL, FALLBACK_OPTIMIZER_MODEL]);
  const models: any[] = [];
  for (const id of preferred) {
    const model = ctx.modelRegistry.find(DEFAULT_OPTIMIZER_PROVIDER, id);
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
  if (models.length === 0) {
    trace("optimizer_model_unavailable", { provider: DEFAULT_OPTIMIZER_PROVIDER });
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
        provider: DEFAULT_OPTIMIZER_PROVIDER,
        modelId: model.id,
        reason: "no_api_key",
      });
      continue;
    }

    trace("optimizer_model_call", {
      provider: DEFAULT_OPTIMIZER_PROVIDER,
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

    try {
      const response = await complete(
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
        { apiKey, maxTokens: optimizerMaxTokens, signal }
      );

      const text = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();

      const parsed = parseOptimizerJson(text, prompt);
      if (!parsed) {
        if (ALLOW_LOOSE_PARSE) {
          const loose = parseOptimizerLoose(text, prompt);
          if (loose) {
            trace("optimizer_model_loose_parsed", {
              provider: DEFAULT_OPTIMIZER_PROVIDER,
              modelId: model.id,
              mode: loose.mode,
              confidence: loose.confidence,
            });
            return { result: loose, modelId: model.id };
          }
          trace("optimizer_model_loose_rejected", {
            provider: DEFAULT_OPTIMIZER_PROVIDER,
            modelId: model.id,
            responseChars: text.length,
          });
        }
        trace("optimizer_model_parse_failed", {
          provider: DEFAULT_OPTIMIZER_PROVIDER,
          modelId: model.id,
          responseChars: text.length,
        });
        continue;
      }

      trace("optimizer_model_parsed", {
        provider: DEFAULT_OPTIMIZER_PROVIDER,
        modelId: model.id,
        mode: parsed.mode,
        confidence: parsed.confidence,
      });
      return { result: parsed, modelId: model.id };
    } finally {
      if (progressTimer) clearTimeout(progressTimer);
      if (ctx.hasUI) {
        ctx.ui.setWorkingMessage();
        ctx.ui.setStatus("hybrid-run", undefined);
        if (longRunningNotified) {
          ctx.ui.notify(`Hybrid optimizer finished (${model.id}).`);
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

/** Store a single RLM chunk in YAMS via temp file. */
async function storeRlmChunk(
  pi: ExtensionAPI,
  name: string,
  content: string,
  metadata: string
): Promise<boolean> {
  const tmpFile = path.join(tmpdir(), `pi-rlm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
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
        RLM_STORE_TAGS,
        "--metadata",
        metadata,
      ],
      { timeout: RLM_STORE_TIMEOUT_MS }
    );
    return result.code === 0;
  } catch {
    return false;
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // Ignore cleanup errors.
    }
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
    const ok = await storeRlmChunk(pi, name, chunk.content, metadata);
    if (ok) {
      stored += 1;
    } else {
      failed += 1;
    }
  }

  return { stored, failed };
}

/** Retrieve relevant session memory chunks from YAMS. */
async function fetchRlmMemory(
  pi: ExtensionAPI,
  prompt: string,
  state: OptimizerState,
  signal?: AbortSignal
): Promise<RlmMemoryHint[]> {
  if (!RLM_ENABLED) return [];

  const query = normalizeLines([state.objective, ...state.carry.slice(-3), prompt])
    .join(" ")
    .slice(0, 900);

  if (!query.trim()) return [];

  const result = await pi.exec(
    "yams",
    [
      "search",
      "--json",
      "--tags",
      "rlm",
      "--limit",
      String(RLM_RETRIEVE_LIMIT + 2),
      query,
    ],
    { timeout: RLM_RETRIEVE_TIMEOUT_MS, signal }
  );

  if (result.code !== 0 || !result.stdout) return [];

  try {
    const parsed = JSON.parse(result.stdout);
    const results: any[] = Array.isArray(parsed) ? parsed : parsed.results || [];
    return results
      .filter(
        (r: any) =>
          typeof r.score === "number" &&
          r.score >= RLM_MIN_SCORE &&
          typeof r.snippet === "string" &&
          r.snippet.length > 0
      )
      .slice(0, RLM_RETRIEVE_LIMIT)
      .map((r: any) => ({
        snippet: r.snippet.replace(/\s+/g, " ").trim(),
        score: r.score,
        chunkType: r.metadata?.chunk_type || "unknown",
      }));
  } catch {
    return [];
  }
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
    optimizerModel: DEFAULT_OPTIMIZER_MODEL,
    optimizations: 0,
    optimizerAttempts: 0,
    optimizerSuccesses: 0,
    optimizerFallbacks: 0,
    failures: 0,
  };
  let compactionInFlight = false;
  let unavailableNotified = false;
  let yamsUnavailableNotified = false;
  let lastCompactionAt = 0;
  let effectiveContextWindow: number | null = null;

  // RLM session state
  let rlmSessionId = `pi-${Date.now().toString(36)}`;
  let rlmTurnCounter = 0;
  let rlmLastMemoryHints: RlmMemoryHint[] = [];
  let rlmUnavailableNotified = false;

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
    const required = [
      { role: "optimizer", provider: DEFAULT_OPTIMIZER_PROVIDER, id: DEFAULT_OPTIMIZER_MODEL },
      { role: "research-optimizer", provider: DEFAULT_OPTIMIZER_PROVIDER, id: RESEARCH_OPTIMIZER_MODEL },
      { role: "oracle", provider: ORACLE_PROVIDER, id: ORACLE_MODEL },
    ];
    const missing: string[] = [];
    for (const check of required) {
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
    const configuredContextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : null;
    effectiveContextWindow = await fetchLoadedContextWindow(ctx.model?.id || "");
    setStatus(ctx);
    const missingModels = auditModelAvailability(ctx);
    const memoryMode = YAMS_ENABLED ? "yams:on" : "yams:off";
    const rlmMode = RLM_ENABLED ? "rlm:on" : "rlm:off";
    trace("session_start", {
      optimizerModel: state.optimizerModel,
      primaryModel: PRIMARY_MODEL,
      configuredContextWindow,
      effectiveContextWindow,
      memoryMode,
      rlmMode,
      rlmSessionId,
      optimizations: state.optimizations,
      optimizerAttempts: state.optimizerAttempts,
      optimizerSuccesses: state.optimizerSuccesses,
      optimizerFallbacks: state.optimizerFallbacks,
      missingModels,
    });
    notify(ctx, `Hybrid optimizer active (${state.optimizerModel}, ${memoryMode}, ${rlmMode}).`);
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
      notify(
        ctx,
        `Hybrid context mismatch: configured=${configuredContextWindow.toLocaleString()} loaded=${effectiveContextWindow.toLocaleString()} (using loaded limit).`,
        "warning"
      );
    }
  });

  // RLM: Extract and store memory chunks before compaction evicts messages
  pi.on("session_before_compact", async (event, ctx) => {
    if (!RLM_ENABLED) return; // Don't interfere with compaction-guard

    const prep = (event as any).preparation;
    const messages = prep?.messagesToSummarize;
    if (!Array.isArray(messages) || messages.length === 0) return;

    rlmTurnCounter += 1;
    const chunks = extractMemoryChunks(messages, state);
    if (chunks.length === 0) {
      trace("rlm_extraction", { chunkCount: 0, messagesProcessed: messages.length, turnNumber: rlmTurnCounter });
      return;
    }

    trace("rlm_extraction", {
      chunkCount: chunks.length,
      messagesProcessed: messages.length,
      turnNumber: rlmTurnCounter,
      chunkTypes: chunks.map((c) => c.type),
    });
    notify(ctx, `RLM: extracting ${chunks.length} memory chunks from ${messages.length} evicted messages.`);

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

  pi.registerCommand("hybrid-proof", {
    description: "Probe optimizer model availability",
    handler: async (_args, ctx) => {
      const probe = "Create a concise coding execution brief for adding tests to a TypeScript extension.";
      state.optimizerAttempts += 1;
      trace("optimizer_attempt", {
        promptChars: probe.length,
        attempt: state.optimizerAttempts,
        configuredModel: DEFAULT_OPTIMIZER_MODEL,
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
        configuredModel: RESEARCH_OPTIMIZER_MODEL,
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
    if (shouldSkipPrompt(prompt)) return;
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

    let result = buildFallback(effectivePrompt);
    let optimizerModelId = profile === "research" ? RESEARCH_OPTIMIZER_MODEL : DEFAULT_OPTIMIZER_MODEL;
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
        const rlmHints = await fetchRlmMemory(pi, effectivePrompt, state, signal);
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
    const response: any = {
      systemPrompt: `${event.systemPrompt}\n\n${buildSystemPromptPatch(state, result, profile, oracleReview, contextSteering, rlmLastMemoryHints)}`,
    };

    if (FORWARD_OPTIMIZED_MESSAGE) {
      const forwarded = buildForwardedPrompt(effectivePrompt, result);
      response.message = {
        customType: "hybrid-forwarded-prompt",
        content: forwarded,
        display: false,
      };
      trace("optimizer_forwarded_prompt", {
        chars: forwarded.length,
        profile,
        source,
      });
    }

    return response;
  });

  pi.on("context", async (event) => {
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

    const filtered = event.messages.filter((_message: any, index: number) => keep[index]);

    const assistantIndexes: number[] = [];
    for (let i = 0; i < filtered.length; i += 1) {
      if (filtered[i]?.role === "assistant") assistantIndexes.push(i);
    }
    const keepSet = new Set(assistantIndexes.slice(Math.max(0, assistantIndexes.length - KEEP_RECENT_ASSISTANT_MESSAGES)));

    const compacted = filtered.map((message: any, index: number) => {
      if (message?.role !== "assistant" || !Array.isArray(message?.content)) return message;
      if (keepSet.has(index)) return message;

      let changed = false;
      const nextContent = message.content
        .filter((block: any) => {
          if (block?.type === "thinking") {
            changed = true;
            return false;
          }
          return true;
        })
        .map((block: any) => {
          if (block?.type === "text" && typeof block.text === "string" && block.text.length > CAP_OLD_ASSISTANT_TEXT_CHARS) {
            changed = true;
            return { ...block, text: truncate(block.text, CAP_OLD_ASSISTANT_TEXT_CHARS) };
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
      });
    }

    if (mutated) {
      return { messages: compacted };
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (compactionInFlight) return;
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
        compactionInFlight = false;
        trace("compaction_complete");
        notify(ctx, "Hybrid compaction complete.");
      },
      onError: (error) => {
        compactionInFlight = false;
        trace("compaction_error", { message: error.message });
        notify(ctx, `Hybrid compaction failed: ${error.message}`, "error");
      },
    });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    effectiveContextWindow = null;
    setStatus(ctx);
  });
}
