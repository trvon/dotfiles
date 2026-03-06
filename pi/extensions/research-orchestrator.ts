import fs from "node:fs";
import { homedir } from "node:os";

import { stream } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { extractResponseText, getSidecarConfig, resolveActiveProvider, resolveSidecarProvider } from "./model-backend.ts";

type ResearchState = {
  topic: string;
  gatherOutput: string;
  critiqueOutput: string;
  followupQueries: string[];
  gatherModel: string;
  gatherCriticModel: string;
  criticModel: string;
  runs: number;
  updatedAt: number;
};

type CritiqueResult = {
  verdict: string;
  confidence: number;
  strengths: string[];
  gaps: string[];
  followupQueries: string[];
  nextActions: string[];
};

const DCS_ROOT = process.env.PI_RESEARCH_DCS_ROOT || "/Users/trevon/work/tools/yams/external/agent";
const DCS_TIMEOUT_MS = parsePositiveInt(process.env.PI_RESEARCH_DCS_TIMEOUT_MS, 900_000);
const DCS_CONTEXT_PROFILE = process.env.PI_RESEARCH_DCS_CONTEXT_PROFILE || "large";
const FRAMEWORK_CLI = process.env.PI_RESEARCH_FRAMEWORK_CLI || "research-agent";

// --- Auto-trigger settings ---
const RESEARCH_AUTO = parseBoolean(process.env.PI_RESEARCH_AUTO, true);
const RESEARCH_AUTO_COOLDOWN_MS = parsePositiveInt(process.env.PI_RESEARCH_AUTO_COOLDOWN_MS, 300_000); // 5 min

const ENV_PRIMARY_MODEL = (process.env.PI_PRIMARY_MODEL || "").trim();
const ENV_CRITIC_PROVIDER = (process.env.PI_RESEARCH_CRITIC_PROVIDER || "").trim();
const CRITIC_MODEL = (process.env.PI_RESEARCH_CRITIC_MODEL || ENV_PRIMARY_MODEL).trim();
const CRITIC_MAX_TOKENS = parsePositiveInt(process.env.PI_RESEARCH_CRITIC_MAX_TOKENS, 900);
const CRITIC_INACTIVITY_MS = parsePositiveInt(process.env.PI_RESEARCH_CRITIC_INACTIVITY_MS, 45000);

const TRACE_FILE = process.env.PI_RESEARCH_TRACE_FILE || `${homedir()}/.pi/agent/research-orchestrator.jsonl`;

type FrameworkExecResult = {
  code: number;
  stdout: string;
  stderr: string;
  killed?: boolean;
  cli: string;
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const lower = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(lower)) return true;
  if (["0", "false", "no", "off"].includes(lower)) return false;
  return fallback;
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

function stripWrapperBlocks(prompt: string): string {
  return prompt
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, " ")
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Detect whether a prompt has research intent.  Uses the same signal set as
 * hybrid-optimizer's `detectProfile` so both agree on routing.
 */
function detectResearchIntent(prompt: string): boolean {
  const p = stripWrapperBlocks(prompt).toLowerCase();
  const signals = [
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
  return signals.some((s) => p.includes(s));
}

function resolvePrimaryModelId(ctx: ExtensionContext): string {
  const preferred = normalizeLines([ctx.model?.id || "", ENV_PRIMARY_MODEL]);
  return preferred[0] || "";
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
    if (controller.signal.aborted) {
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

function trace(type: string, payload: Record<string, unknown> = {}): void {
  if (!TRACE_FILE) return;
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), type, ...payload });
    fs.appendFileSync(TRACE_FILE, `${line}\n`, "utf-8");
  } catch {
    // Ignore trace failures.
  }
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  if (!ctx.hasUI) return;
  ctx.ui.notify(message, type);
}

function extractJsonObject(raw: string): string {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) return raw;
  return raw.slice(start, end + 1);
}

function parseCritiqueJson(raw: string): CritiqueResult | null {
  const cleaned = extractJsonObject(raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, ""));
  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const strengths = Array.isArray(parsed.strengths)
      ? normalizeLines(parsed.strengths.filter((v): v is string => typeof v === "string"))
      : [];
    const gaps = Array.isArray(parsed.gaps)
      ? normalizeLines(parsed.gaps.filter((v): v is string => typeof v === "string"))
      : [];
    const followupQueries = Array.isArray(parsed.followupQueries)
      ? normalizeLines(parsed.followupQueries.filter((v): v is string => typeof v === "string"))
      : [];
    const nextActions = Array.isArray(parsed.nextActions)
      ? normalizeLines(parsed.nextActions.filter((v): v is string => typeof v === "string"))
      : [];

    return {
      verdict: typeof parsed.verdict === "string" ? parsed.verdict.trim() : "needs-improvement",
      confidence: typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence) ? parsed.confidence : 0.45,
      strengths,
      gaps,
      followupQueries: followupQueries.slice(0, 8),
      nextActions: nextActions.slice(0, 8),
    };
  } catch {
    return null;
  }
}

function fallbackCritique(text: string): CritiqueResult {
  const lines = normalizeLines(text.split("\n")).slice(0, 6);
  return {
    verdict: "needs-improvement",
    confidence: 0.35,
    strengths: lines.slice(0, 2),
    gaps: ["Missing structured evidence table validation.", "Need contradiction check across at least two sources."],
    followupQueries: [
      "recent peer-reviewed survey on this topic",
      "benchmark comparisons and failure modes",
      "contradictory findings and limitations",
    ],
    nextActions: ["Run a second gather pass focused on gaps.", "Produce final synthesis with explicit uncertainty labels."],
  };
}

function extractDcsOutput(stdout: string): string {
  const marker = "Output";
  const idx = stdout.lastIndexOf(marker);
  if (idx < 0) return stdout.trim();
  const tail = stdout.slice(idx + marker.length);
  const cleaned = tail.replace(/^[\s\-\u2500]+/gm, "").trim();
  if (!cleaned) return stdout.trim();
  return cleaned;
}

function parseFrameworkStatusModel(stdout: string): string {
  const match = stdout.match(/model=([^\s]+)/i);
  return match?.[1]?.trim() || "";
}

function parseFrameworkRunModels(stdout: string): { executor: string; critic: string } {
  const execMatch = stdout.match(/Executor:\s*([^|\n]+)/i);
  const criticMatch = stdout.match(/Critic:\s*([^|\n]+)/i);
  return {
    executor: execMatch?.[1]?.trim() || "",
    critic: criticMatch?.[1]?.trim() || "",
  };
}

function buildGatherPrompt(topic: string): string {
  return [
    `Conduct a literature gather pass for topic: ${topic}`,
    "Use retrieval-grounded evidence only.",
    "Return markdown with sections:",
    "## Scope",
    "## Core Findings",
    "## Evidence Table (source | claim | confidence)",
    "## Contradictions",
    "## Gaps",
    "Each claim must cite a source path or identifier.",
  ].join("\n");
}

function buildCritiquePrompt(topic: string, gathered: string): string {
  return [
    "You are a strict research critic for literature review notes.",
    "Return strict JSON with keys:",
    "verdict, confidence, strengths, gaps, followupQueries, nextActions",
    "Rules:",
    "- prioritize groundedness and citation quality",
    "- identify missing seminal work / contradictory evidence",
    "- followupQueries must be specific retrieval queries",
    `Topic: ${topic}`,
    "Gathered notes:",
    truncate(gathered, 11_000),
  ].join("\n");
}

function restoreState(ctx: ExtensionContext): ResearchState {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as any;
    if (entry?.type !== "custom" || entry?.customType !== "research-orchestrator-state") continue;
    const data = entry.data as Partial<ResearchState> | undefined;
    return {
      topic: typeof data?.topic === "string" ? data.topic : "",
      gatherOutput: typeof data?.gatherOutput === "string" ? data.gatherOutput : "",
      critiqueOutput: typeof data?.critiqueOutput === "string" ? data.critiqueOutput : "",
      followupQueries: Array.isArray(data?.followupQueries)
        ? normalizeLines(data.followupQueries.filter((v): v is string => typeof v === "string"))
        : [],
      gatherModel: typeof data?.gatherModel === "string" ? data.gatherModel : "",
      gatherCriticModel: typeof data?.gatherCriticModel === "string" ? data.gatherCriticModel : "",
      criticModel: typeof data?.criticModel === "string" ? data.criticModel : "",
      runs: typeof data?.runs === "number" ? data.runs : 0,
      updatedAt: typeof data?.updatedAt === "number" ? data.updatedAt : Date.now(),
    };
  }

  return {
    topic: "",
    gatherOutput: "",
    critiqueOutput: "",
    followupQueries: [],
    gatherModel: "",
    gatherCriticModel: "",
    criticModel: "",
    runs: 0,
    updatedAt: Date.now(),
  };
}

function isCommandMissing(stderr: string, stdout: string): boolean {
  const text = `${stderr || ""}\n${stdout || ""}`.toLowerCase();
  return (
    text.includes("no such command") ||
    text.includes("command not found") ||
    text.includes("unknown command") ||
    text.includes("is not installed") ||
    text.includes("could not find")
  );
}

function resolveFrameworkCliCandidates(): string[] {
  const candidates = [FRAMEWORK_CLI, "dcs"];
  return [...new Set(candidates.map((x) => x.trim()).filter(Boolean))];
}

async function runFrameworkCli(
  pi: ExtensionAPI,
  args: string[],
  signal?: AbortSignal
): Promise<FrameworkExecResult> {
  const candidates = resolveFrameworkCliCandidates();
  let lastResult: FrameworkExecResult | null = null;

  for (const cli of candidates) {
    trace("framework_exec_attempt", { cli, args });
    const result = await pi.exec("uv", ["run", "--project", DCS_ROOT, cli, ...args], {
      timeout: DCS_TIMEOUT_MS,
      signal,
    });

    const wrapped: FrameworkExecResult = { ...result, cli };
    if (result.code === 0) return wrapped;

    const missing = isCommandMissing(result.stderr || "", result.stdout || "");
    trace("framework_exec_failed", {
      cli,
      code: result.code,
      missingCommand: missing,
      stderr: truncate(result.stderr || "", 220),
      stdout: truncate(result.stdout || "", 220),
    });

    lastResult = wrapped;
    if (!missing) return wrapped;
  }

  return (
    lastResult || {
      code: 1,
      stdout: "",
      stderr: "research framework command unavailable",
      cli: FRAMEWORK_CLI,
    }
  );
}

async function gatherWithDcs(
  pi: ExtensionAPI,
  topic: string,
  signal?: AbortSignal
): Promise<{ output: string; raw: string; ok: boolean; cli: string }> {
  const task = buildGatherPrompt(topic);
  const result = await runFrameworkCli(
    pi,
    ["run", task, "--context-profile", DCS_CONTEXT_PROFILE, "--ground-truth-mode", "--dspy-faithfulness"],
    signal
  );
  const raw = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  const output = extractDcsOutput(result.stdout || result.stderr || "");
  return { output: output.trim(), raw, ok: result.code === 0, cli: result.cli };
}

function resolveCriticModel(ctx: ExtensionContext): any {
  const provider = ENV_CRITIC_PROVIDER || resolveActiveProvider(ctx);
  const sc = getSidecarConfig(provider);
  // Use PRIMARY provider for research critic (35B model) — not sidecar (9B).
  // The sidecar 9B lacks the precision needed for faithful critique.
  const lookupProvider = ENV_CRITIC_PROVIDER || provider;
  const primaryModelId = resolvePrimaryModelId(ctx);
  const criticModelId = sc.critic || primaryModelId;
  const ids = [
    primaryModelId,
    CRITIC_MODEL,
    criticModelId,
  ];
  const deduped = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  for (const id of deduped) {
    const model = ctx.modelRegistry.find(lookupProvider, id);
    if (model) return model;
  }
  return null;
}

async function critiqueGathering(ctx: ExtensionContext, topic: string, gathered: string): Promise<{ critique: CritiqueResult; modelId: string }> {
  const model = resolveCriticModel(ctx);
  if (!model) {
    return { critique: fallbackCritique(gathered), modelId: "fallback" };
  }

  const apiKey = await ctx.modelRegistry.getApiKey(model);
  if (!apiKey) {
    return { critique: fallbackCritique(gathered), modelId: "fallback" };
  }

  try {
    const response = await completeWithInactivityTimeout(
      model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: buildCritiquePrompt(topic, gathered) }],
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey, maxTokens: CRITIC_MAX_TOKENS },
      CRITIC_INACTIVITY_MS
    );

    const { text, source: textSource } = extractResponseText(response);
    if (textSource === "thinking") {
      trace("critic_using_thinking_fallback", { modelId: model.id, chars: text.length });
    }
    const parsed = parseCritiqueJson(text);
    if (!parsed) {
      trace("critic_parse_fallback", { modelId: model.id, textSource });
      return { critique: fallbackCritique(gathered), modelId: model.id };
    }

    return { critique: parsed, modelId: model.id };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown";
    const isInactivity = msg === "inactivity_timeout";
    trace(isInactivity ? "critic_inactivity_timeout" : "critic_exception", {
      message: msg,
      inactivityMs: CRITIC_INACTIVITY_MS,
    });
    return { critique: fallbackCritique(gathered), modelId: model.id };
  }
}

function formatCritiqueMarkdown(critique: CritiqueResult): string {
  const strengths = critique.strengths.length > 0 ? critique.strengths.map((s) => `- ${s}`).join("\n") : "- none";
  const gaps = critique.gaps.length > 0 ? critique.gaps.map((g) => `- ${g}`).join("\n") : "- none";
  const queries =
    critique.followupQueries.length > 0
      ? critique.followupQueries.map((q) => `- ${q}`).join("\n")
      : "- none";
  const actions = critique.nextActions.length > 0 ? critique.nextActions.map((a) => `- ${a}`).join("\n") : "- none";

  return [
    `Verdict: ${critique.verdict}`,
    `Confidence: ${critique.confidence.toFixed(2)}`,
    "",
    "Strengths:",
    strengths,
    "",
    "Gaps:",
    gaps,
    "",
    "Follow-up Queries:",
    queries,
    "",
    "Next Actions:",
    actions,
  ].join("\n");
}

function buildAutoResearchBrief(topic: string, gathered: string, critique: CritiqueResult, models: {
  frameworkCli: string;
  frameworkExecutor: string;
  frameworkCritic: string;
  criticModel: string;
}): string {
  const findings = normalizeLines(gathered.split("\n")).slice(0, 10).map((line) => `- ${line}`);
  const gaps = critique.gaps.slice(0, 4).map((line) => `- ${line}`);
  const queries = critique.followupQueries.slice(0, 4).map((line) => `- ${line}`);

  return [
    `[Research Brief — auto-injected for current turn]`,
    `Topic: ${topic}`,
    `Framework: cli=${models.frameworkCli} executor=${models.frameworkExecutor || "unknown"} frameworkCritic=${models.frameworkCritic || "unknown"} critic=${models.criticModel || "unknown"}`,
    `Critic verdict: ${critique.verdict} (confidence=${critique.confidence.toFixed(2)})`,
    "",
    "Use this research brief in the current response. Treat it as retrieval-grounded context to cite, cross-check, and prioritize.",
    "",
    "Key Findings:",
    findings.length > 0 ? findings.join("\n") : "- none",
    "",
    "Known Gaps:",
    gaps.length > 0 ? gaps.join("\n") : "- none",
    "",
    "Suggested Retrieval Follow-ups:",
    queries.length > 0 ? queries.join("\n") : "- none",
  ].join("\n");
}

function buildAutoResearchSystemPatch(topic: string, critique: CritiqueResult): string {
  const guidance = [
    `[Research Context Patch]`,
    `A research gather+critic pass was completed for this user turn on topic: ${topic}`,
    `Critic verdict: ${critique.verdict}; confidence=${critique.confidence.toFixed(2)}.`,
    "Use the injected research brief as current-turn context.",
    "If you rely on claims from the brief, keep them grounded and preserve uncertainty where gaps remain.",
  ];

  if (critique.gaps.length > 0) {
    guidance.push(`Open gaps to acknowledge: ${critique.gaps.slice(0, 3).join(" | ")}`);
  }

  return guidance.join("\n");
}

export default function researchOrchestratorExtension(pi: ExtensionAPI): void {
  let state: ResearchState = {
    topic: "",
    gatherOutput: "",
    critiqueOutput: "",
    followupQueries: [],
    gatherModel: "",
    gatherCriticModel: "",
    criticModel: "",
    runs: 0,
    updatedAt: Date.now(),
  };

  // --- Auto-trigger state ---
  let lastAutoTriggerAt = 0;
  let autoTriggerInFlight = false;

  function persist(): void {
    state.updatedAt = Date.now();
    pi.appendEntry("research-orchestrator-state", state);
  }

  function setStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const t = ctx.ui.theme;
    const runs = t.fg("accent", String(state.runs));
    const topic = state.topic ? truncate(state.topic, 28) : "idle";
    const exec = state.gatherModel ? ` e:${truncate(state.gatherModel, 14)}` : "";
    ctx.ui.setStatus("research", `${t.fg("dim", "research:")}${runs}${t.fg("dim", ` ${topic}${exec}`)}`);
  }

  async function runStackStatus(ctx: ExtensionContext): Promise<void> {
    const [yams, framework] = await Promise.all([
      pi.exec("yams", ["status"], { timeout: 30_000 }),
      runFrameworkCli(pi, ["status"]),
    ]);

    const yamsOk = yams.code === 0;
    const frameworkOk = framework.code === 0;
    const frameworkModel = parseFrameworkStatusModel(framework.stdout || "");
    trace("status", {
      yamsOk,
      frameworkOk,
      frameworkCli: framework.cli,
      frameworkModel,
    });

    const msg = [
      `research status: yams=${yamsOk ? "ok" : "fail"} framework=${frameworkOk ? "ok" : "fail"} cli=${framework.cli}${frameworkModel ? ` model=${frameworkModel}` : ""}`,
      !yamsOk ? truncate(yams.stderr || yams.stdout || "", 220) : "",
      !frameworkOk ? truncate(framework.stderr || framework.stdout || "", 220) : "",
    ]
      .filter(Boolean)
      .join("\n");

    notify(ctx, msg, yamsOk && frameworkOk ? "info" : "warning");
  }

  pi.on("session_start", async (_event, ctx) => {
    state = restoreState(ctx);
    setStatus(ctx);
    const primaryModelId = resolvePrimaryModelId(ctx);
    const criticResolved = resolveCriticModel(ctx);
    const criticConfigured = Boolean(criticResolved);
    trace("session_start", {
      dcsRoot: DCS_ROOT,
      runs: state.runs,
      primaryModel: primaryModelId || null,
      criticResolvedModel: criticResolved?.id || null,
      criticConfigured,
      frameworkCli: FRAMEWORK_CLI,
    });
    notify(
      ctx,
      `Research orchestrator ready (framework cli=${FRAMEWORK_CLI}). Commands: /research-status /research-gather /research-critic /research-review`
    );
    if (!criticConfigured) {
      notify(
        ctx,
        `Research critic model unavailable (${ENV_CRITIC_PROVIDER || "auto"}); fallback chain will be used.`,
        "warning"
      );
    }
  });

  // ---------------------------------------------------------------------------
  // Auto-trigger: when the user's prompt has research intent, run the DCS
  // pipeline (gather + critique) synchronously inside before_agent_start and
  // inject a compact research brief into the SAME turn. This ensures research
  // participates in the main context-curation scaffold instead of arriving as a
  // later follow-up turn.
  // ---------------------------------------------------------------------------
  pi.on("before_agent_start", async (event, ctx) => {
    if (!RESEARCH_AUTO) {
      trace("research_auto_skipped", { reason: "disabled" });
      return;
    }
    if (autoTriggerInFlight) {
      trace("research_auto_skipped", { reason: "already_in_flight" });
      return;
    }

    const prompt = (event.prompt || "").trim();
    if (!prompt) return;

    if (!detectResearchIntent(prompt)) {
      trace("research_auto_skipped", { reason: "no_research_intent", promptChars: prompt.length });
      return;
    }

    const now = Date.now();
    if (now - lastAutoTriggerAt < RESEARCH_AUTO_COOLDOWN_MS) {
      trace("research_auto_skipped", {
        reason: "cooldown",
        cooldownMs: RESEARCH_AUTO_COOLDOWN_MS,
        elapsedMs: now - lastAutoTriggerAt,
      });
      return;
    }

    // Use the user prompt as the DCS task.  The decomposer will break it
    // into YAMS queries; the critic loop quality-gates the output.
    const topic = prompt.length > 300 ? prompt.slice(0, 300).trimEnd() : prompt;

    lastAutoTriggerAt = now;
    autoTriggerInFlight = true;
    trace("research_auto_triggered", { topic: truncate(topic, 120), promptChars: prompt.length });
    notify(ctx, `Research pipeline blocking current turn: ${truncate(topic, 80)}`);

    try {
      const gathered = await gatherWithDcs(pi, topic);
      if (!gathered.ok) {
        trace("research_auto_gather_failed", { topic, out: truncate(gathered.raw, 400) });
        notify(ctx, `Research auto-gather failed: ${truncate(gathered.raw, 200)}`, "warning");
        return;
      }

      const { critique, modelId } = await critiqueGathering(ctx, topic, gathered.output);
      const critiqueMd = formatCritiqueMarkdown(critique);
      const runModels = parseFrameworkRunModels(gathered.raw);

      state.topic = topic;
      state.gatherOutput = gathered.output;
      state.critiqueOutput = critiqueMd;
      state.followupQueries = critique.followupQueries;
      state.gatherModel = runModels.executor || "framework-executor-unknown";
      state.gatherCriticModel = runModels.critic || "framework-critic-unknown";
      state.criticModel = modelId;
      state.runs += 1;
      persist();
      setStatus(ctx);

      const researchBrief = buildAutoResearchBrief(topic, gathered.output, critique, {
        frameworkCli: gathered.cli,
        frameworkExecutor: state.gatherModel,
        frameworkCritic: state.gatherCriticModel,
        criticModel: modelId,
      });
      const systemPrompt = [
        event.systemPrompt,
        buildAutoResearchSystemPatch(topic, critique),
      ].join("\n\n");

      trace("research_auto_injected", {
        topic,
        frameworkCli: gathered.cli,
        frameworkExecutor: state.gatherModel,
        frameworkCritic: state.gatherCriticModel,
        criticModel: modelId,
        gatherChars: gathered.output.length,
        injectedChars: researchBrief.length,
        critiqueConfidence: critique.confidence,
        queries: critique.followupQueries.length,
      });
      notify(ctx, "Research brief injected into current turn.");

      return {
        systemPrompt,
        message: {
          customType: "research-auto-brief",
          content: researchBrief,
          display: false,
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      trace("research_auto_error", { error: msg });
      notify(ctx, `Research auto-trigger error: ${msg}`, "warning");
      return;
    } finally {
      autoTriggerInFlight = false;
    }
  });

  pi.registerCommand("research-status", {
    description: "Check research framework + YAMS stack health",
    handler: async (_args, ctx) => runStackStatus(ctx),
  });

  pi.registerCommand("research-framework-status", {
    description: "Alias: check research framework + YAMS stack health",
    handler: async (_args, ctx) => runStackStatus(ctx),
  });

  pi.registerCommand("research-gather", {
    description: "Run research framework gather phase for literature review topic",
    handler: async (args, ctx) => {
      const topic = args.trim();
      if (!topic) {
        notify(ctx, "Usage: /research-gather <topic>", "warning");
        return;
      }

      notify(ctx, `Research gather running: ${truncate(topic, 80)}`);
      const signal = (ctx as any).signal as AbortSignal | undefined;
      const gathered = await gatherWithDcs(pi, topic, signal);

      if (!gathered.ok) {
        trace("gather_failed", { topic, out: truncate(gathered.raw, 400) });
        notify(ctx, `Research gather failed:\n${truncate(gathered.raw, 400)}`, "error");
        return;
      }

      const runModels = parseFrameworkRunModels(gathered.raw);
      state.topic = topic;
      state.gatherOutput = gathered.output;
      state.gatherModel = runModels.executor || "framework-executor-unknown";
      state.gatherCriticModel = runModels.critic || "framework-critic-unknown";
      state.runs += 1;
      persist();
      setStatus(ctx);
      trace("gather_success", {
        topic,
        chars: gathered.output.length,
        frameworkCli: gathered.cli,
        executor: state.gatherModel,
        critic: state.gatherCriticModel,
      });
      notify(
        ctx,
        `Research gather complete (${gathered.output.length.toLocaleString()} chars). cli=${gathered.cli} executor=${state.gatherModel} critic=${state.gatherCriticModel}. Use /research-critic next.`
      );
    },
  });

  pi.registerCommand("research-critic", {
    description: "Critique latest gather output (or provided text)",
    handler: async (args, ctx) => {
      const input = args.trim();
      const gathered = input || state.gatherOutput;
      const topic = state.topic || "literature review";
      if (!gathered) {
        notify(ctx, "No gather output available. Run /research-gather <topic> first.", "warning");
        return;
      }

      notify(ctx, "Research critic running...");
      const { critique, modelId } = await critiqueGathering(ctx, topic, gathered);
      state.criticModel = modelId;
      state.critiqueOutput = formatCritiqueMarkdown(critique);
      state.followupQueries = critique.followupQueries;
      persist();
      setStatus(ctx);
      trace("critic_done", { modelId, confidence: critique.confidence, gaps: critique.gaps.length });

      notify(
        ctx,
        `Research critic complete (${modelId}). Confidence=${critique.confidence.toFixed(2)} | gaps=${critique.gaps.length}`
      );
    },
  });

  pi.registerCommand("research-pack", {
    description: "Show latest gather + critic packet",
    handler: async (_args, ctx) => {
      if (!state.gatherOutput) {
        notify(ctx, "No research packet yet. Run /research-gather <topic>.", "warning");
        return;
      }

      const packet = [
        `Topic: ${state.topic || "unknown"}`,
        `Gather model: ${state.gatherModel || "unknown"}`,
        `Framework critic model: ${state.gatherCriticModel || "unknown"}`,
        `Critic model: ${state.criticModel || "unknown"}`,
        "",
        "Gathered notes:",
        truncate(state.gatherOutput, 1200),
        "",
        "Critique notes:",
        truncate(state.critiqueOutput || "(none)", 900),
      ].join("\n");

      notify(ctx, packet);
    },
  });

  pi.registerCommand("research-review", {
    description: "Run gather+critic then queue final synthesis turn",
    handler: async (args, ctx) => {
      const topic = args.trim();
      if (!topic) {
        notify(ctx, "Usage: /research-review <topic>", "warning");
        return;
      }

      notify(ctx, `Research review pipeline started: ${truncate(topic, 80)}`);
      const signal = (ctx as any).signal as AbortSignal | undefined;
      const gathered = await gatherWithDcs(pi, topic, signal);
      if (!gathered.ok) {
        notify(ctx, `Gather failed:\n${truncate(gathered.raw, 400)}`, "error");
        return;
      }

      const { critique, modelId } = await critiqueGathering(ctx, topic, gathered.output);
      const critiqueMd = formatCritiqueMarkdown(critique);
      const runModels = parseFrameworkRunModels(gathered.raw);

      state.topic = topic;
      state.gatherOutput = gathered.output;
      state.critiqueOutput = critiqueMd;
      state.followupQueries = critique.followupQueries;
      state.gatherModel = runModels.executor || "framework-executor-unknown";
      state.gatherCriticModel = runModels.critic || "framework-critic-unknown";
      state.criticModel = modelId;
      state.runs += 1;
      persist();
      setStatus(ctx);

      const packet = [
        `[research-review packet]`,
        `Topic: ${topic}`,
        "",
        "Gathered evidence:",
        truncate(gathered.output, 6000),
        "",
        "Critic report:",
        critiqueMd,
        "",
        "Task:",
        "Produce a final literature review with explicit citations, contradictions, uncertainty labels, and next retrieval steps.",
      ].join("\n");

      if (ctx.isIdle()) {
        pi.sendUserMessage(packet);
      } else {
        pi.sendUserMessage(packet, { deliverAs: "followUp" });
      }

      trace("review_queued", {
        topic,
        frameworkCli: gathered.cli,
        frameworkExecutor: state.gatherModel,
        frameworkCritic: state.gatherCriticModel,
        criticModel: modelId,
        queries: critique.followupQueries.length,
      });
      notify(ctx, "Research review packet queued to agent.");
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    setStatus(ctx);
  });
}
