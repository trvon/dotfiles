import fs from "node:fs";
import { homedir } from "node:os";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { fetchModelInfoAll, getModelCapabilities, inferModelSource, resolveActiveProvider } from "./model-backend.ts";
import type { ModelInfo } from "./model-backend.ts";

const TRACE_FILE = process.env.PI_RUNTIME_TRACE_FILE || `${homedir()}/.pi/agent/runtime-trace.jsonl`;
const TRACE_ENABLED = parseBoolean(process.env.PI_RUNTIME_TRACE_ENABLED, true);
const MAX_TEXT = parsePositiveInt(process.env.PI_RUNTIME_TRACE_MAX_TEXT, 320);
const ENV_PRIMARY_MODEL = (process.env.PI_PRIMARY_MODEL || "").trim();
const DOCTOR_SIGNAL_WINDOW_MS = parsePositiveInt(process.env.PI_DOCTOR_SIGNAL_WINDOW_MS, 900_000);

type TraceTarget = {
  name: string;
  path: string;
  enabled: boolean;
};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function resolvePrimaryModelId(ctx: ExtensionContext): string {
  const sessionModel = typeof ctx.model?.id === "string" ? ctx.model.id.trim() : "";
  if (sessionModel) return sessionModel;
  return ENV_PRIMARY_MODEL;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    if (typeof block.text === "string") parts.push(block.text);
    if (typeof block.content === "string") parts.push(block.content);
    if (typeof block.thinking === "string") parts.push(block.thinking);
  }
  return parts.join("\n");
}

function writeTrace(type: string, payload: Record<string, unknown> = {}): void {
  if (!TRACE_ENABLED) return;
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), type, ...payload });
    fs.appendFileSync(TRACE_FILE, `${line}\n`, "utf-8");
  } catch {
    // Ignore trace write failures.
  }
}

function summarizeToolError(event: any): string {
  const detailsError = event?.result?.details?.error;
  if (typeof detailsError === "string" && detailsError.trim()) return detailsError.trim();
  const resultText = extractText(event?.result?.content || "").trim();
  if (resultText) return truncate(resultText, MAX_TEXT);
  return "unknown";
}

function summarizeMessage(message: any): string {
  const text = extractText(message?.content || "").replace(/\s+/g, " ").trim();
  return truncate(text, MAX_TEXT);
}

function getTraceTargets(): TraceTarget[] {
  const compactionTraceFile = process.env.PI_COMPACTION_GUARD_TRACE_FILE || `${homedir()}/.pi/agent/compaction-guard.jsonl`;
  const watchdogTraceFile = process.env.PI_HEALTH_WATCHDOG_TRACE_FILE || `${homedir()}/.pi/agent/health-watchdog.jsonl`;
  const hybridTraceFile = process.env.PI_HYBRID_TRACE_FILE || `${homedir()}/.pi/agent/hybrid-optimizer.jsonl`;
  const researchTraceFile = process.env.PI_RESEARCH_TRACE_FILE || `${homedir()}/.pi/agent/research-orchestrator.jsonl`;
  const streamSaverTraceFile = process.env.PI_STREAM_SAVER_TRACE_FILE || `${homedir()}/.pi/agent/stream-saver.jsonl`;

  return [
    { name: "runtime", path: TRACE_FILE, enabled: TRACE_ENABLED },
    { name: "compaction", path: compactionTraceFile, enabled: true },
    { name: "watchdog", path: watchdogTraceFile, enabled: true },
    { name: "hybrid", path: hybridTraceFile, enabled: true },
    { name: "research", path: researchTraceFile, enabled: true },
    { name: "stream-saver", path: streamSaverTraceFile, enabled: true },
  ];
}

function getFileSizeBytes(filePath: string): number {
  try {
    if (!filePath || !fs.existsSync(filePath)) return 0;
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function buildTraceStatusSummary(targets: TraceTarget[]): { message: string; sizes: Record<string, number> } {
  const sizes: Record<string, number> = {};
  const parts: string[] = [];
  for (const target of targets) {
    if (!target.enabled) {
      parts.push(`${target.name}=off`);
      continue;
    }
    const size = getFileSizeBytes(target.path);
    sizes[target.name] = size;
    parts.push(`${target.name}=${size}B`);
  }
  return {
    message: `trace ${parts.join(" | ")}`,
    sizes,
  };
}

function readRecentTraceEvents(filePath: string, maxLines = 400): any[] {
  try {
    if (!filePath || !fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter(Boolean).slice(-maxLines);
    const out: any[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line));
      } catch {
        // Ignore malformed lines.
      }
    }
    return out;
  } catch {
    return [];
  }
}

type SignalCounts = {
  lengthStops: number;
  writeSchemaErrors: number;
  terminations: number;
};

type WindowCount = {
  recent: number;
  total: number;
};

function makeWindowCount(): WindowCount {
  return { recent: 0, total: 0 };
}

function bumpWindowCount(counter: WindowCount, inRecentWindow: boolean): void {
  counter.total += 1;
  if (inRecentWindow) counter.recent += 1;
}

function eventIsRecent(event: any, nowMs: number, windowMs: number): boolean {
  const tsMs = typeof event?.ts === "string" ? Date.parse(event.ts) : NaN;
  return Number.isFinite(tsMs) && nowMs - tsMs <= windowMs;
}

function formatClock(ts: unknown): string {
  if (typeof ts !== "string") return "??:??:??";
  const time = ts.split("T")[1] || "";
  return time.replace("Z", "").slice(0, 8) || "??:??:??";
}

function lastEventTs(events: any[]): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (typeof events[i]?.ts === "string") return events[i].ts;
  }
  return null;
}

function analyzeWatchdogTrace(events: any[], nowMs: number, windowMs: number) {
  const pseudoToolCalls = makeWindowCount();
  const semanticToolFailures = makeWindowCount();
  const retries = makeWindowCount();
  const recoveries = makeWindowCount();
  const suppressions = makeWindowCount();
  const verifierErrors = makeWindowCount();
  const finalTailTimeouts = makeWindowCount();

  for (const event of events) {
    const inRecentWindow = eventIsRecent(event, nowMs, windowMs);
    switch (event?.type) {
      case "pseudo_tool_call_detected":
        bumpWindowCount(pseudoToolCalls, inRecentWindow);
        break;
      case "semantic_tool_failure_detected":
        bumpWindowCount(semanticToolFailures, inRecentWindow);
        break;
      case "retry_triggered":
        bumpWindowCount(retries, inRecentWindow);
        break;
      case "termination_recovery_triggered":
        bumpWindowCount(recoveries, inRecentWindow);
        break;
      case "termination_recovery_suppressed":
        bumpWindowCount(suppressions, inRecentWindow);
        break;
      case "verifier_error":
      case "termination_verifier_error":
        bumpWindowCount(verifierErrors, inRecentWindow);
        break;
      case "final_tail_timeout":
        bumpWindowCount(finalTailTimeouts, inRecentWindow);
        break;
      default:
        break;
    }
  }

  const significant = new Set([
    "pseudo_tool_call_detected",
    "semantic_tool_failure_detected",
    "retry_triggered",
    "termination_recovery_triggered",
    "termination_recovery_suppressed",
    "verifier_error",
    "termination_verifier_error",
    "final_tail_timeout",
  ]);

  const recentEvents = events
    .filter((event) => significant.has(event?.type))
    .slice(-6)
    .map((event) => {
      const at = formatClock(event?.ts);
      switch (event?.type) {
        case "pseudo_tool_call_detected":
          return `${at} pseudo-tool-call chars=${event?.assistantChars ?? "?"}`;
        case "semantic_tool_failure_detected":
          return `${at} semantic-tool-failure tool=${event?.toolName || "bash"}`;
        case "retry_triggered":
          return `${at} retry stall=${event?.stallKind || "unknown"} count=${event?.retryCount ?? "?"}`;
        case "termination_recovery_triggered":
          return `${at} recovery stop=${event?.stopReason || "unknown"} retry=${event?.retryCount ?? "?"}`;
        case "termination_recovery_suppressed":
          return `${at} suppressed reason=${event?.reason || "unknown"}`;
        case "verifier_error":
        case "termination_verifier_error":
          return `${at} verifier-error ${truncate(String(event?.message || "unknown"), 80)}`;
        case "final_tail_timeout":
          return `${at} final-tail-timeout source=${event?.source || "unknown"}`;
        default:
          return `${at} ${event?.type || "unknown"}`;
      }
    });

  return {
    pseudoToolCalls,
    semanticToolFailures,
    retries,
    recoveries,
    suppressions,
    verifierErrors,
    finalTailTimeouts,
    recentEvents,
    lastTs: lastEventTs(events),
  };
}

function analyzeHybridTrace(events: any[], nowMs: number, windowMs: number) {
  const parseFailures = makeWindowCount();
  const fallbacks = makeWindowCount();
  const contextWarnings = makeWindowCount();

  for (const event of events) {
    const inRecentWindow = eventIsRecent(event, nowMs, windowMs);
    if (["optimizer_model_parse_failed", "oracle_parse_failed", "rlm_extractor_model_parse_failed"].includes(event?.type)) {
      bumpWindowCount(parseFailures, inRecentWindow);
    }
    if (["optimizer_fallback", "rlm_extractor_fallback"].includes(event?.type)) {
      bumpWindowCount(fallbacks, inRecentWindow);
    }
    if (["context_budget_warning", "context_window_override"].includes(event?.type)) {
      bumpWindowCount(contextWarnings, inRecentWindow);
    }
  }

  const recentEvents = events
    .filter((event) => ["optimizer_model_parse_failed", "oracle_parse_failed", "optimizer_fallback", "context_budget_warning"].includes(event?.type))
    .slice(-5)
    .map((event) => `${formatClock(event?.ts)} ${event?.type}`);

  return { parseFailures, fallbacks, contextWarnings, recentEvents, lastTs: lastEventTs(events) };
}

function analyzeResearchTrace(events: any[], nowMs: number, windowMs: number) {
  const autoInjected = makeWindowCount();
  const gatherFailures = makeWindowCount();
  const autoErrors = makeWindowCount();
  const criticFallbacks = makeWindowCount();

  for (const event of events) {
    const inRecentWindow = eventIsRecent(event, nowMs, windowMs);
    if (event?.type === "research_auto_injected") bumpWindowCount(autoInjected, inRecentWindow);
    if (event?.type === "research_auto_gather_failed") bumpWindowCount(gatherFailures, inRecentWindow);
    if (event?.type === "research_auto_error") bumpWindowCount(autoErrors, inRecentWindow);
    if (event?.type === "critic_parse_fallback") bumpWindowCount(criticFallbacks, inRecentWindow);
  }

  const recentEvents = events
    .filter((event) => ["research_auto_injected", "research_auto_gather_failed", "research_auto_error", "critic_parse_fallback"].includes(event?.type))
    .slice(-5)
    .map((event) => `${formatClock(event?.ts)} ${event?.type}`);

  return { autoInjected, gatherFailures, autoErrors, criticFallbacks, recentEvents, lastTs: lastEventTs(events) };
}

function analyzeCompactionTrace(events: any[], nowMs: number, windowMs: number) {
  const failures = makeWindowCount();
  const fallbacks = makeWindowCount();
  const retries = makeWindowCount();

  for (const event of events) {
    const inRecentWindow = eventIsRecent(event, nowMs, windowMs);
    if (["compaction_9b_failed", "compaction_dcs_failed", "compaction_9b_retry_failed"].includes(event?.type)) {
      bumpWindowCount(failures, inRecentWindow);
    }
    if (["compaction_heuristic_fallback", "safe_compaction_used"].includes(event?.type)) {
      bumpWindowCount(fallbacks, inRecentWindow);
    }
    if (["compaction_9b_retry_attempt", "compaction_9b_retry_success"].includes(event?.type)) {
      bumpWindowCount(retries, inRecentWindow);
    }
  }

  const recentEvents = events
    .filter((event) => ["compaction_9b_failed", "compaction_heuristic_fallback", "compaction_9b_retry_failed"].includes(event?.type))
    .slice(-5)
    .map((event) => `${formatClock(event?.ts)} ${event?.type}`);

  return { failures, fallbacks, retries, recentEvents, lastTs: lastEventTs(events) };
}

function analyzeStreamTrace(events: any[], nowMs: number, windowMs: number) {
  const recoveries = makeWindowCount();
  const sendErrors = makeWindowCount();
  const activeStreamEnds = makeWindowCount();

  for (const event of events) {
    const inRecentWindow = eventIsRecent(event, nowMs, windowMs);
    if (event?.type === "recovery_persisted") bumpWindowCount(recoveries, inRecentWindow);
    if (event?.type === "recovery_send_error") bumpWindowCount(sendErrors, inRecentWindow);
    if (event?.type === "agent_end_active_stream") bumpWindowCount(activeStreamEnds, inRecentWindow);
  }

  const recentEvents = events
    .filter((event) => ["recovery_persisted", "recovery_send_error", "agent_end_active_stream"].includes(event?.type))
    .slice(-5)
    .map((event) => `${formatClock(event?.ts)} ${event?.type}`);

  return { recoveries, sendErrors, activeStreamEnds, recentEvents, lastTs: lastEventTs(events) };
}

function analyzeToolingPatterns(events: any[], nowMs: number, windowMs: number) {
  const maskedPipelines = makeWindowCount();
  const samples: string[] = [];

  for (const event of events) {
    if (event?.type !== "tool_start" || event?.toolName !== "bash") continue;
    const args = String(event?.args || "");
    const lower = args.toLowerCase();
    const masked = lower.includes("| head") || lower.includes("| tail");
    if (!masked) continue;
    const inRecentWindow = eventIsRecent(event, nowMs, windowMs);
    bumpWindowCount(maskedPipelines, inRecentWindow);
    if (samples.length < 4) samples.push(`${formatClock(event?.ts)} ${truncate(args, 120)}`);
  }

  return { maskedPipelines, samples };
}

function analyzeRuntimeSignals(
  events: any[],
  nowMs: number,
  windowMs: number
): { recent: SignalCounts; total: SignalCounts } {
  const recent: SignalCounts = { lengthStops: 0, writeSchemaErrors: 0, terminations: 0 };
  const total: SignalCounts = { lengthStops: 0, writeSchemaErrors: 0, terminations: 0 };

  for (const event of events) {
    const tsMs = typeof event?.ts === "string" ? Date.parse(event.ts) : NaN;
    const inRecentWindow = Number.isFinite(tsMs) && nowMs - tsMs <= windowMs;

    if (event?.type === "turn_end" && event?.stopReason === "length") {
      total.lengthStops += 1;
      if (inRecentWindow) recent.lengthStops += 1;
    }
    if (event?.type === "tool_end" && event?.toolName === "write" && event?.isError) {
      const text = String(event?.error || "").toLowerCase();
      if (
        text.includes("validation failed for tool \"write\"") &&
        text.includes("required property 'path'") &&
        text.includes("required property 'content'")
      ) {
        total.writeSchemaErrors += 1;
        if (inRecentWindow) recent.writeSchemaErrors += 1;
      }
    }
    if (event?.type === "termination_tool_detected" || event?.type === "termination_message_detected") {
      total.terminations += 1;
      if (inRecentWindow) recent.terminations += 1;
    }
  }

  return { recent, total };
}

const MESSAGE_UPDATE_TRACE_INTERVAL = parsePositiveInt(process.env.PI_RUNTIME_TRACE_UPDATE_INTERVAL, 50);
const TPS_STATUS_KEY = "tps";
const TPS_UPDATE_INTERVAL_MS = 500; // Update status bar at ~2Hz during streaming

export default function runtimeTraceExtension(pi: ExtensionAPI): void {
  // State for tracking assistant streaming in-progress (observability gap fix).
  let assistantStreamActive = false;
  let assistantStreamUpdateCount = 0;
  let assistantStreamBufferedChars = 0;
  let assistantStreamStartedAt = 0;

  // State for tok/s measurement
  let turnStartedAt = 0;            // When the turn began (for prompt eval timing)
  let firstTokenAt = 0;             // When the first text/thinking delta arrived
  let genTokenCount = 0;            // Approximate token count from deltas during generation
  let lastTpsUpdateAt = 0;          // Last time we updated the status bar
  let tpsCtx: ExtensionContext | null = null; // Cached context ref for status updates

  function resetStreamState(): void {
    assistantStreamActive = false;
    assistantStreamUpdateCount = 0;
    assistantStreamBufferedChars = 0;
    assistantStreamStartedAt = 0;
  }

  function resetTpsState(): void {
    turnStartedAt = 0;
    firstTokenAt = 0;
    genTokenCount = 0;
    lastTpsUpdateAt = 0;
  }

  function formatTps(tokensPerSec: number): string {
    if (tokensPerSec >= 100) return `${Math.round(tokensPerSec)} t/s`;
    if (tokensPerSec >= 10) return `${tokensPerSec.toFixed(1)} t/s`;
    return `${tokensPerSec.toFixed(2)} t/s`;
  }

  function updateTpsStatus(ctx: ExtensionContext, text: string): void {
    if (ctx.hasUI) ctx.ui.setStatus(TPS_STATUS_KEY, text);
  }

  async function handleTraceStatus(ctx: ExtensionContext): Promise<void> {
    const targets = getTraceTargets();
    const status = buildTraceStatusSummary(targets);
    if (ctx.hasUI) ctx.ui.notify(status.message);
    writeTrace("trace_status", { sizes: status.sizes });
  }

  async function handleTraceClear(ctx: ExtensionContext): Promise<void> {
    const targets = getTraceTargets();
    const cleared: string[] = [];
    for (const target of targets) {
      if (!target.enabled || !target.path) continue;
      try {
        fs.writeFileSync(target.path, "", "utf-8");
        cleared.push(target.name);
      } catch {
        // Ignore individual clear failures.
      }
    }
    if (ctx.hasUI) ctx.ui.notify(`trace cleared: ${cleared.join(", ") || "none"}`);
    writeTrace("trace_cleared", { cleared });
  }

  async function handleTraceMark(args: string, ctx: ExtensionContext): Promise<void> {
    const label = args.trim() || "manual-mark";
    writeTrace("mark", { label });
    if (ctx.hasUI) ctx.ui.notify(`trace mark: ${label}`);
  }

  async function handleDoctor(args: string, ctx: ExtensionContext): Promise<void> {
    const mode = args.trim().toLowerCase() || "status";
    const targets = getTraceTargets();
    const status = buildTraceStatusSummary(targets);
    const targetMap = new Map(targets.map((target) => [target.name, target.path]));
    const nowMs = Date.now();
    const runtimeEvents = readRecentTraceEvents(TRACE_FILE, 900);
    const signals = analyzeRuntimeSignals(runtimeEvents, nowMs, DOCTOR_SIGNAL_WINDOW_MS);
    const primaryModelId = resolvePrimaryModelId(ctx);
    const configuredContext = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : null;

    const allInfo = await fetchModelInfoAll(primaryModelId);
    const loaded: ModelInfo = allInfo.find((i) => i.state === "loaded")
      || allInfo[0]
      || { backend: "unknown", state: "unavailable", loadedContextLength: null, maxContextLength: null };
    const activeProvider = resolveActiveProvider(ctx);
    const modelCheck = Boolean(primaryModelId && ctx.modelRegistry.find(activeProvider, primaryModelId));
    const capabilities = primaryModelId ? getModelCapabilities(activeProvider, primaryModelId) : null;
    const modelSource = inferModelSource(loaded);

    const watchdogEvents = readRecentTraceEvents(targetMap.get("watchdog") || "", 600);
    const hybridEvents = readRecentTraceEvents(targetMap.get("hybrid") || "", 600);
    const researchEvents = readRecentTraceEvents(targetMap.get("research") || "", 600);
    const compactionEvents = readRecentTraceEvents(targetMap.get("compaction") || "", 600);
    const streamEvents = readRecentTraceEvents(targetMap.get("stream-saver") || "", 600);

    const watchdog = analyzeWatchdogTrace(watchdogEvents, nowMs, DOCTOR_SIGNAL_WINDOW_MS);
    const hybrid = analyzeHybridTrace(hybridEvents, nowMs, DOCTOR_SIGNAL_WINDOW_MS);
    const research = analyzeResearchTrace(researchEvents, nowMs, DOCTOR_SIGNAL_WINDOW_MS);
    const compaction = analyzeCompactionTrace(compactionEvents, nowMs, DOCTOR_SIGNAL_WINDOW_MS);
    const stream = analyzeStreamTrace(streamEvents, nowMs, DOCTOR_SIGNAL_WINDOW_MS);
    const tooling = analyzeToolingPatterns(runtimeEvents, nowMs, DOCTOR_SIGNAL_WINDOW_MS);

    const backendLines = allInfo.map(
      (info) =>
        `${info.backend} state=${info.state} loadedContext=${info.loadedContextLength ?? "unknown"} configuredContext=${configuredContext ?? "unknown"}`
    );
    if (backendLines.length === 0) {
      backendLines.push(`backend state=unavailable loadedContext=unknown configuredContext=${configuredContext ?? "unknown"}`);
    }

    const hasContextMismatch =
      Boolean(configuredContext) &&
      Boolean(loaded.loadedContextLength) &&
      Number(loaded.loadedContextLength) > 0 &&
      Number(loaded.loadedContextLength) < Number(configuredContext);

    const warnings: string[] = [];
    if (hasContextMismatch) {
      warnings.push(`context mismatch configured=${configuredContext?.toLocaleString()} loaded=${loaded.loadedContextLength?.toLocaleString()}`);
    }
    if (watchdog.pseudoToolCalls.recent > 0) warnings.push(`pseudo tool-call stops detected (${watchdog.pseudoToolCalls.recent} recent)`);
    if (watchdog.semanticToolFailures.recent > 0) warnings.push(`semantic bash failures detected (${watchdog.semanticToolFailures.recent} recent)`);
    if (tooling.maskedPipelines.recent > 0) warnings.push(`masked bash pipelines detected (${tooling.maskedPipelines.recent} recent)`);
    if (signals.recent.writeSchemaErrors >= 2) warnings.push(`write schema errors elevated (${signals.recent.writeSchemaErrors} recent)`);
    if (signals.recent.lengthStops >= 3) warnings.push(`length stops elevated (${signals.recent.lengthStops} recent)`);
    if (hybrid.parseFailures.recent > 0) warnings.push(`hybrid parse failures detected (${hybrid.parseFailures.recent} recent)`);
    if (research.gatherFailures.recent > 0 || research.autoErrors.recent > 0) warnings.push("research auto pipeline has recent failures");
    if (capabilities && capabilities.toolFidelityTier === "low") warnings.push("model capability reports low tool-fidelity tier");
    if (capabilities && capabilities.reasoning && capabilities.reasoningFormat === "qwen") warnings.push("qwen thinking format active: ensure thinking fallback parsers remain healthy");

    const traceFreshness = targets
      .filter((target) => target.enabled)
      .map((target) => {
        const events = readRecentTraceEvents(target.path, 5);
        return `${target.name} last=${lastEventTs(events) ? formatClock(lastEventTs(events)) : "none"} size=${status.sizes[target.name] ?? 0}B`;
      });

    const summaryLines = [
      `doctor model=${ctx.model?.id || "unknown"}`,
      `primary=${primaryModelId || "unknown"} registry=${modelCheck ? "ok" : "missing"}`,
      `modelSource=${modelSource} backendModel=${loaded.resolvedModelId || "unknown"}`,
      `capability parser=${capabilities?.parserProfile || "unknown"} toolTier=${capabilities?.toolFidelityTier || "unknown"} reasoning=${capabilities ? (capabilities.reasoning ? "on" : "off") : "unknown"}`,
      ...backendLines,
      `runtime recent(${Math.round(DOCTOR_SIGNAL_WINDOW_MS / 60000)}m) lengthStops=${signals.recent.lengthStops} writeSchemaErrors=${signals.recent.writeSchemaErrors} terminations=${signals.recent.terminations}`,
      `watchdog recent pseudo=${watchdog.pseudoToolCalls.recent} semantic=${watchdog.semanticToolFailures.recent} retries=${watchdog.retries.recent} recoveries=${watchdog.recoveries.recent} suppressions=${watchdog.suppressions.recent}`,
      `hybrid recent parseFailures=${hybrid.parseFailures.recent} fallbacks=${hybrid.fallbacks.recent} contextWarnings=${hybrid.contextWarnings.recent}`,
      `research recent injected=${research.autoInjected.recent} gatherFailures=${research.gatherFailures.recent} autoErrors=${research.autoErrors.recent}`,
      `compaction recent failures=${compaction.failures.recent} fallbacks=${compaction.fallbacks.recent} retries=${compaction.retries.recent}`,
      `stream recent recoveries=${stream.recoveries.recent} sendErrors=${stream.sendErrors.recent} activeEnds=${stream.activeStreamEnds.recent}`,
      `tooling recent maskedPipelines=${tooling.maskedPipelines.recent}`,
      warnings.length > 0 ? `warnings ${warnings.join(" | ")}` : "warnings none",
      status.message,
    ];

    const watchdogSection = [
      "[watchdog]",
      `pseudo recent=${watchdog.pseudoToolCalls.recent} total=${watchdog.pseudoToolCalls.total}`,
      `semantic recent=${watchdog.semanticToolFailures.recent} total=${watchdog.semanticToolFailures.total}`,
      `retries recent=${watchdog.retries.recent} total=${watchdog.retries.total}`,
      `recoveries recent=${watchdog.recoveries.recent} total=${watchdog.recoveries.total}`,
      `suppressions recent=${watchdog.suppressions.recent} total=${watchdog.suppressions.total}`,
      `verifierErrors recent=${watchdog.verifierErrors.recent} total=${watchdog.verifierErrors.total}`,
      ...(watchdog.recentEvents.length > 0 ? ["recent:", ...watchdog.recentEvents.map((line) => `- ${line}`)] : ["recent: none"]),
    ];

    const modelSection = [
      "[model]",
      `session=${ctx.model?.id || "unknown"}`,
      `primary=${primaryModelId || "unknown"}`,
      `provider=${activeProvider}`,
      `registry=${modelCheck ? "ok" : "missing"}`,
      `source=${modelSource}`,
      `backendModelId=${loaded.resolvedModelId || "unknown"}`,
      `parserProfile=${capabilities?.parserProfile || "unknown"}`,
      `toolTier=${capabilities?.toolFidelityTier || "unknown"}`,
      `reasoning=${capabilities ? (capabilities.reasoning ? "on" : "off") : "unknown"}${capabilities?.reasoningFormat ? ` (${capabilities.reasoningFormat})` : ""}`,
      ...backendLines,
      `toolFidelityRisk=${watchdog.pseudoToolCalls.recent > 0 || watchdog.semanticToolFailures.recent > 0 ? "elevated" : "normal"}`,
      ...(capabilities?.notes?.length ? [`capabilityNotes=${capabilities.notes.join(" | ")}`] : []),
      ...(hasContextMismatch ? [`warning configured=${configuredContext} loaded=${loaded.loadedContextLength}`] : []),
    ];

    const tracesSection = [
      "[traces]",
      ...traceFreshness,
      status.message,
      ...(tooling.samples.length > 0 ? ["masked pipeline samples:", ...tooling.samples.map((line) => `- ${line}`)] : ["masked pipeline samples: none"]),
    ];

    const allSection = [
      ...summaryLines,
      "",
      ...watchdogSection,
      "",
      "[hybrid]",
      `parseFailures recent=${hybrid.parseFailures.recent} total=${hybrid.parseFailures.total}`,
      `fallbacks recent=${hybrid.fallbacks.recent} total=${hybrid.fallbacks.total}`,
      `contextWarnings recent=${hybrid.contextWarnings.recent} total=${hybrid.contextWarnings.total}`,
      ...(hybrid.recentEvents.length > 0 ? ["recent:", ...hybrid.recentEvents.map((line) => `- ${line}`)] : ["recent: none"]),
      "",
      "[research]",
      `injected recent=${research.autoInjected.recent} total=${research.autoInjected.total}`,
      `gatherFailures recent=${research.gatherFailures.recent} total=${research.gatherFailures.total}`,
      `autoErrors recent=${research.autoErrors.recent} total=${research.autoErrors.total}`,
      `criticFallbacks recent=${research.criticFallbacks.recent} total=${research.criticFallbacks.total}`,
      ...(research.recentEvents.length > 0 ? ["recent:", ...research.recentEvents.map((line) => `- ${line}`)] : ["recent: none"]),
      "",
      "[compaction]",
      `failures recent=${compaction.failures.recent} total=${compaction.failures.total}`,
      `fallbacks recent=${compaction.fallbacks.recent} total=${compaction.fallbacks.total}`,
      `retries recent=${compaction.retries.recent} total=${compaction.retries.total}`,
      ...(compaction.recentEvents.length > 0 ? ["recent:", ...compaction.recentEvents.map((line) => `- ${line}`)] : ["recent: none"]),
      "",
      "[stream]",
      `recoveries recent=${stream.recoveries.recent} total=${stream.recoveries.total}`,
      `sendErrors recent=${stream.sendErrors.recent} total=${stream.sendErrors.total}`,
      `activeEnds recent=${stream.activeStreamEnds.recent} total=${stream.activeStreamEnds.total}`,
      ...(stream.recentEvents.length > 0 ? ["recent:", ...stream.recentEvents.map((line) => `- ${line}`)] : ["recent: none"]),
      "",
      ...modelSection,
      "",
      ...tracesSection,
    ];

    const payload = {
      model: ctx.model?.id || null,
      primaryModel: primaryModelId || null,
      provider: activeProvider,
      registryHasPrimary: modelCheck,
      modelSource,
      backendModelId: loaded.resolvedModelId || null,
      capabilities,
      configuredContext,
      loadedContext: loaded.loadedContextLength,
      loadedState: loaded.state,
      loadedBackend: loaded.backend,
      backends: allInfo.map((i) => ({
        backend: i.backend,
        state: i.state,
        loadedContext: i.loadedContextLength,
        maxContext: i.maxContextLength,
        resolvedModelId: i.resolvedModelId || null,
      })),
      signalWindowMs: DOCTOR_SIGNAL_WINDOW_MS,
      runtimeSignals: signals,
      watchdog,
      hybrid,
      research,
      compaction,
      stream,
      tooling,
      warnings,
      traces: status.sizes,
    };

    let lines: string[];
    if (mode === "status" || mode === "summary") {
      lines = summaryLines;
    } else if (mode === "all") {
      lines = allSection;
    } else if (mode === "watchdog") {
      lines = watchdogSection;
    } else if (mode === "model") {
      lines = modelSection;
    } else if (mode === "traces") {
      lines = tracesSection;
    } else if (mode === "json") {
      lines = [JSON.stringify(payload, null, 2)];
    } else if (mode === "help") {
      lines = [
        "Usage: /doctor [status|all|watchdog|model|traces|json|help]",
        "- status: umbrella diagnostics summary",
        "- all: detailed multi-extension diagnostics",
        "- watchdog: watchdog-specific signals and recent events",
        "- model: backend/model/context/tool-fidelity view",
        "- traces: trace freshness, sizes, and masked-pipeline hints",
        "- json: machine-readable diagnostics payload",
      ];
    } else {
      lines = ["Usage: /doctor [status|all|watchdog|model|traces|json|help]"];
    }

    const level: "info" | "warning" = warnings.length > 0 ? "warning" : "info";
    if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), level);
    writeTrace("doctor", { mode, ...payload });
  }

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("runtime-trace", `trace:${TRACE_ENABLED ? "on" : "off"}`);
      ctx.ui.setStatus(TPS_STATUS_KEY, undefined); // Clear until first generation
      ctx.ui.notify(`Runtime trace ${TRACE_ENABLED ? "active" : "disabled"}.`);
    }
    writeTrace("session_start", {
      cwd: process.cwd(),
      traceFile: TRACE_FILE,
      model: ctx.model?.id,
      provider: ctx.provider?.name,
    });
  });

  pi.registerCommand("trace-status", {
    description: "Show runtime trace status",
    handler: async (_args, ctx) => handleTraceStatus(ctx),
  });

  pi.registerCommand("trace-clear", {
    description: "Clear runtime trace file",
    handler: async (_args, ctx) => handleTraceClear(ctx),
  });

  pi.registerCommand("trace-mark", {
    description: "Write a custom marker to trace",
    handler: async (args, ctx) => handleTraceMark(args, ctx),
  });

  pi.registerCommand("trace", {
    description: "Unified trace command: status|clear|mark <label>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed || trimmed === "status") {
        await handleTraceStatus(ctx);
        return;
      }
      if (trimmed === "clear") {
        await handleTraceClear(ctx);
        return;
      }
      if (trimmed.startsWith("mark")) {
        const label = trimmed.slice("mark".length).trim();
        await handleTraceMark(label, ctx);
        return;
      }
      if (ctx.hasUI) ctx.ui.notify("Usage: /trace [status|clear|mark <label>]", "warning");
    },
  });

  pi.registerCommand("doctor", {
    description: "Unified health diagnostics for extensions and runtime",
    handler: async (args, ctx) => handleDoctor(args, ctx),
  });

  pi.on("agent_start", async (_event, ctx) => {
    writeTrace("agent_start", { model: ctx.model?.id, provider: ctx.provider?.name });
  });

  pi.on("agent_end", async (event) => {
    writeTrace("agent_end", {
      messages: Array.isArray(event?.messages) ? event.messages.length : 0,
      assistantStreamActive,
      assistantStreamUpdateCount,
      assistantStreamBufferedChars,
      assistantStreamElapsedMs: assistantStreamStartedAt > 0 ? Date.now() - assistantStreamStartedAt : -1,
    });
    resetStreamState();
  });

  pi.on("turn_start", async (event, ctx) => {
    resetTpsState();
    turnStartedAt = Date.now();
    tpsCtx = ctx;
    if (ctx.hasUI) updateTpsStatus(ctx, "...");
    writeTrace("turn_start", { turnIndex: event?.turnIndex });
  });

  pi.on("turn_end", async (event, ctx) => {
    const stopReason = event?.message?.stopReason;
    const toolResults = Array.isArray(event?.toolResults) ? event.toolResults.length : 0;
    const usage = event?.message?.usage?.totalTokens ?? null;
    writeTrace("turn_end", { turnIndex: event?.turnIndex, stopReason, toolResults, totalTokens: usage });
    // Keep tpsCtx alive across tool-call turns (don't resetTpsState here —
    // that's done at the next turn_start so the last turn's stats persist in the status bar).
  });

  pi.on("message_start", async (event, ctx) => {
    const role = event?.message?.role || "unknown";
    if (role === "assistant") {
      resetStreamState();
      assistantStreamActive = true;
      assistantStreamStartedAt = Date.now();
      tpsCtx = ctx;
    }
    writeTrace("message_start", { role });
  });

  pi.on("message_update", async (event) => {
    if (!assistantStreamActive) return;

    assistantStreamUpdateCount += 1;

    // Estimate buffered chars from the delta if available.
    const delta = event?.assistantMessageEvent;
    let isTextDelta = false;
    if (delta && typeof delta === "object") {
      if (delta.type === "text_delta" && typeof delta.delta === "string") {
        assistantStreamBufferedChars += delta.delta.length;
        isTextDelta = true;
      } else if (delta.type === "thinking_delta" && typeof delta.delta === "string") {
        assistantStreamBufferedChars += delta.delta.length;
        isTextDelta = true;
      }
    }

    // tok/s tracking: each text/thinking delta is ~1 token
    if (isTextDelta) {
      const now = Date.now();
      if (firstTokenAt === 0) {
        firstTokenAt = now;
        // Show prompt eval latency
        if (turnStartedAt > 0 && tpsCtx) {
          const promptMs = firstTokenAt - turnStartedAt;
          updateTpsStatus(tpsCtx, `pp ${promptMs}ms`);
        }
      }
      genTokenCount += 1;

      // Throttled status bar update during generation
      if (now - lastTpsUpdateAt >= TPS_UPDATE_INTERVAL_MS && firstTokenAt > 0 && tpsCtx) {
        lastTpsUpdateAt = now;
        const genElapsedSec = (now - firstTokenAt) / 1000;
        if (genElapsedSec > 0.1) {
          const tps = genTokenCount / genElapsedSec;
          updateTpsStatus(tpsCtx, `~${formatTps(tps)}`);
        }
      }
    }

    // Sampled trace logging to avoid bloat.
    if (assistantStreamUpdateCount % MESSAGE_UPDATE_TRACE_INTERVAL === 0) {
      writeTrace("message_update_sample", {
        updateCount: assistantStreamUpdateCount,
        bufferedChars: assistantStreamBufferedChars,
        elapsedMs: assistantStreamStartedAt > 0 ? Date.now() - assistantStreamStartedAt : -1,
      });
    }
  });

  pi.on("message_end", async (event, ctx) => {
    const message = event?.message;
    const role = message?.role || "unknown";
    const summary = summarizeMessage(message);
    const stopReason = message?.stopReason;

    // Compute final tok/s using actual output token count from usage
    let finalGenTps: number | null = null;
    let finalPromptMs: number | null = null;
    let genElapsedMs: number | null = null;
    let outputTokens: number | null = null;

    if (role === "assistant" && firstTokenAt > 0) {
      const endTime = Date.now();
      genElapsedMs = endTime - firstTokenAt;
      finalPromptMs = turnStartedAt > 0 ? firstTokenAt - turnStartedAt : null;

      // Prefer actual output token count from usage
      outputTokens = message?.usage?.output ?? null;
      const tokenCount = outputTokens ?? genTokenCount;

      if (genElapsedMs > 0 && tokenCount > 0) {
        finalGenTps = (tokenCount / genElapsedMs) * 1000;
      }

      // Update status bar with final precise reading
      if (finalGenTps !== null && ctx.hasUI) {
        const parts: string[] = [];
        if (finalPromptMs !== null) parts.push(`pp ${finalPromptMs}ms`);
        parts.push(formatTps(finalGenTps));
        if (outputTokens !== null) parts.push(`${outputTokens}tok`);
        updateTpsStatus(ctx, parts.join(" | "));
      }
    }

    writeTrace("message_end", {
      role,
      stopReason,
      summary,
      assistantStreamWasActive: role === "assistant" ? assistantStreamActive : undefined,
      assistantStreamUpdateCount: role === "assistant" ? assistantStreamUpdateCount : undefined,
      assistantStreamBufferedChars: role === "assistant" ? assistantStreamBufferedChars : undefined,
      genTps: finalGenTps !== null ? Math.round(finalGenTps * 100) / 100 : undefined,
      promptMs: finalPromptMs ?? undefined,
      genElapsedMs: genElapsedMs ?? undefined,
      outputTokens: outputTokens ?? undefined,
    });

    if (role === "assistant") {
      resetStreamState();
    }

    const lower = summary.toLowerCase();
    if (lower.includes("error: terminated") || lower === "terminated" || lower.includes("operation aborted")) {
      writeTrace("termination_message_detected", {
        role,
        summary,
        idle: ctx.isIdle(),
        stopReason,
      });
    }
  });

  pi.on("tool_execution_start", async (event) => {
    writeTrace("tool_start", {
      toolCallId: event?.toolCallId,
      toolName: event?.toolName,
      args: truncate(JSON.stringify(event?.args || {}), MAX_TEXT),
    });
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    const errorText = event?.isError ? summarizeToolError(event) : "";
    writeTrace("tool_end", {
      toolCallId: event?.toolCallId,
      toolName: event?.toolName,
      isError: Boolean(event?.isError),
      error: errorText,
      idle: ctx.isIdle(),
    });

    const lower = errorText.toLowerCase();
    if (event?.isError && (lower.includes("terminated") || lower.includes("aborted") || lower.includes("cancel"))) {
      writeTrace("termination_tool_detected", {
        toolCallId: event?.toolCallId,
        toolName: event?.toolName,
        error: errorText,
      });
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    resetStreamState();
    resetTpsState();
    tpsCtx = null;
    if (ctx?.hasUI) {
      ctx.ui.setStatus("runtime-trace", undefined);
      ctx.ui.setStatus(TPS_STATUS_KEY, undefined);
    }
    writeTrace("session_shutdown");
  });
}
