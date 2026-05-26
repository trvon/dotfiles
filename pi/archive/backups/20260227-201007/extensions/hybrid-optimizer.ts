import fs from "node:fs";

import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type Mode = "fast" | "deep";
type OptimizationProfile = "general" | "research";

type OptimizerState = {
  objective: string;
  carry: string[];
  memoryHints: Array<{ path: string; snippet: string; score: number }>;
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

const DEFAULT_OPTIMIZER_PROVIDER = process.env.PI_OPTIMIZER_PROVIDER || "lmstudio";
const DEFAULT_OPTIMIZER_MODEL = process.env.PI_OPTIMIZER_MODEL || "unsloth/qwen3.5-27b";
const FALLBACK_OPTIMIZER_MODEL = "mistralai/ministral-3-14b-reasoning";
const RESEARCH_OPTIMIZER_MODEL = process.env.PI_OPTIMIZER_RESEARCH_MODEL || "unsloth/qwen3.5-27b";

const MIN_PROMPT_CHARS_FOR_OPTIMIZER = parsePositiveInt(process.env.PI_OPTIMIZER_MIN_CHARS, 120);
const OPTIMIZER_MAX_TOKENS = parsePositiveInt(process.env.PI_OPTIMIZER_MAX_TOKENS, 700);
const UI_PROGRESS_NOTIFY_MS = parsePositiveInt(process.env.PI_HYBRID_UI_PROGRESS_NOTIFY_MS, 1500);
const AUTO_THINKING = parseBoolean(process.env.PI_HYBRID_AUTO_THINKING, true);
const YAMS_ENABLED = parseBoolean(process.env.PI_HYBRID_YAMS_ENABLED, true);
const PROFILE_EMBED_ROUTER = parseBoolean(process.env.PI_HYBRID_PROFILE_EMBED_ROUTER, true);
const YAMS_LIMIT = parsePositiveInt(process.env.PI_HYBRID_YAMS_LIMIT, 4);
const YAMS_TIMEOUT_MS = parsePositiveInt(process.env.PI_HYBRID_YAMS_TIMEOUT_MS, 4500);
const TRACE_FILE = process.env.PI_HYBRID_TRACE_FILE || "";

const COMPACTION_RATIO = parseRatio(process.env.PI_HYBRID_COMPACTION_RATIO, 0.82);
const COMPACTION_MIN_TOKENS = parsePositiveInt(process.env.PI_HYBRID_COMPACTION_MIN_TOKENS, 180000);
const COMPACTION_COOLDOWN_MS = parsePositiveInt(process.env.PI_HYBRID_COMPACTION_COOLDOWN_MS, 180000);
const MAX_BRIEF_CHARS = 2200;
const MAX_CARRY_ITEMS = 6;
const MAX_HINTS_IN_PROMPT = 3;
const MAX_HINT_SNIPPET_CHARS = 220;
const KEEP_RECENT_ASSISTANT_MESSAGES = parsePositiveInt(process.env.PI_HYBRID_KEEP_RECENT_ASSISTANT, 6);
const CAP_OLD_ASSISTANT_TEXT_CHARS = parsePositiveInt(process.env.PI_HYBRID_CAP_OLD_ASSISTANT_TEXT, 1800);

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

function parseOptimizerJson(raw: string): OptimizerResult | null {
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

    return {
      mode,
      optimizedPrompt: optimizedPrompt || "Preserve user intent and execute efficiently.",
      executionBrief: executionBrief || "No additional brief provided.",
      objective: objective || "",
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

  const objective = truncate((objectiveMatch?.[1] || prompt).trim(), 240);
  const executionBrief = truncate((briefMatch?.[1] || text).trim(), 700);
  const optimizedPrompt = truncate((promptMatch?.[1] || prompt).trim(), 850);
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

function buildSystemPromptPatch(state: OptimizerState, result: OptimizerResult, profile: OptimizationProfile): string {
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

  const patch = [
    "[Hybrid Guidance]",
    `Profile: ${profile}`,
    `Mode: ${result.mode}`,
    `Optimizer confidence: ${result.confidence.toFixed(2)}`,
    `Objective: ${truncate(result.objective || state.objective, 280)}`,
    `Execution brief: ${truncate(result.executionBrief, 700)}`,
    `Optimized prompt framing: ${truncate(result.optimizedPrompt, 850)}`,
    "Carry context:",
    carryText,
    "Retrieved memory hints:",
    hintsText,
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
    "- If uncertain, ask one focused clarifying question after doing all non-blocked work.",
  ].join("\n");

  return truncate(patch, MAX_BRIEF_CHARS);
}

function resolveOptimizerModels(ctx: ExtensionContext, profile: OptimizationProfile): any[] {
  const preferred =
    profile === "research"
      ? normalizeLines([
          RESEARCH_OPTIMIZER_MODEL,
          "qwen3.5-27b-heretic",
          "mlx-community/qwen3.5-27b",
          DEFAULT_OPTIMIZER_MODEL,
          FALLBACK_OPTIMIZER_MODEL,
          "qwen/qwen3.5-35b-a3b",
        ])
      : normalizeLines([DEFAULT_OPTIMIZER_MODEL, FALLBACK_OPTIMIZER_MODEL, "qwen/qwen3.5-35b-a3b"]);
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
  signal?: AbortSignal
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
    profile === "research"
      ? "- For research/literature prompts, emphasize evidence-first workflow: local code and docs first, then external sources."
      : "- Keep execution oriented and concise.",
    profile === "research"
      ? "- Do NOT recommend searching prompt/skill catalogs for paper content unless explicitly requested."
      : "- Prefer direct file operations over broad catalog searches.",
    "Current carry context:",
    carryContext,
    "User prompt:",
    prompt,
  ].join("\n");

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
        { apiKey, maxTokens: OPTIMIZER_MAX_TOKENS, signal }
      );

      const text = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();

      const parsed = parseOptimizerJson(text);
      if (!parsed) {
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

export default function hybridOptimizerExtension(pi: ExtensionAPI): void {
  let state: OptimizerState = {
    objective: "",
    carry: [],
    memoryHints: [],
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

  function persist(): void {
    state.updatedAt = Date.now();
    pi.appendEntry("hybrid-optimizer-state", state);
  }

  pi.on("session_start", async (_event, ctx) => {
    state = restoreState(ctx);
    yamsUnavailableNotified = false;
    setStatus(ctx);
    const memoryMode = YAMS_ENABLED ? "yams:on" : "yams:off";
    trace("session_start", {
      optimizerModel: state.optimizerModel,
      memoryMode,
      optimizations: state.optimizations,
      optimizerAttempts: state.optimizerAttempts,
      optimizerSuccesses: state.optimizerSuccesses,
      optimizerFallbacks: state.optimizerFallbacks,
    });
    notify(ctx, `Hybrid optimizer active (${state.optimizerModel}, ${memoryMode}).`);
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
        `hints=${state.memoryHints.length}`,
      ].join(" | ");
      notify(ctx, `Hybrid status: ${summary}`);
    },
  });

  pi.registerCommand("hybrid-reset", {
    description: "Clear hybrid optimizer carry state",
    handler: async (_args, ctx) => {
      state.objective = "";
      state.carry = [];
      state.memoryHints = [];
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

  pi.on("before_agent_start", async (event, ctx) => {
    const prompt = (event.prompt || "").trim();
    if (shouldSkipPrompt(prompt)) return;
    const signal = (event as any).signal as AbortSignal | undefined;
    const cleanedPrompt = stripWrapperBlocks(prompt);
    const effectivePrompt = cleanedPrompt || prompt;
    let profile = detectProfile(effectivePrompt);
    const bypassOptimizer = shouldBypassOptimizer(effectivePrompt);
    let preloadedHints: Array<{ path: string; snippet: string; score: number }> | null = null;

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
        const optimized = await optimizeWithModel(ctx, effectivePrompt, state, profile, signal);
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

    state.lastMode = result.mode;
    state.lastProfile = profile;
    state.lastOptimizationSource = source;
    state.objective = result.objective || state.objective || truncate(effectivePrompt, 240);
    state.carry = normalizeLines([...state.carry, ...result.carry]).slice(-MAX_CARRY_ITEMS);
    state.optimizerModel = optimizerModelId;
    state.optimizations += 1;
    persist();

    if (AUTO_THINKING) {
      pi.setThinkingLevel(result.mode === "deep" ? "medium" : "low");
    }

    setStatus(ctx);
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildSystemPromptPatch(state, result, profile)}`,
    };
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

    const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : 128000;
    const threshold = Math.max(Math.floor(contextWindow * COMPACTION_RATIO), COMPACTION_MIN_TOKENS);
    if (usage.tokens < threshold) return;

    compactionInFlight = true;
    lastCompactionAt = now;
    trace("compaction_trigger", { tokens: usage.tokens, threshold });
    notify(
      ctx,
      `Hybrid compaction triggered at ${usage.tokens.toLocaleString()} tokens (${Math.round(COMPACTION_RATIO * 100)}%).`
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
    setStatus(ctx);
  });
}
