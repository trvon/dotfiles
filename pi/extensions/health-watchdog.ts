import fs from "node:fs";
import { homedir } from "node:os";

import { stream } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { extractResponseText, getSidecarConfig, resolveActiveProvider, resolveSidecarProvider } from "./model-backend.ts";

type CronDeliverMode = "immediate" | "followUp";

type CronJob = {
  name: string;
  prompt: string;
  everyMs: number;
  enabled: boolean;
  deliverWhenBusy: boolean;
  deliverMode: CronDeliverMode;
};

type CronFileShape = {
  jobs?: Array<Partial<CronJob> & { every?: string; everyMs?: number }>;
};

type TerminationMode = "aggressive" | "balanced";

type TerminationCandidate = {
  stopReason: string;
  summary: string;
  assistantChars: number;
  priorAssistantChars: number;
  priorAssistantAgeMs: number;
  priorAssistantClosed: boolean;
  detectedAt: number;
  signature: string;
  kind?: "termination" | "pseudo_tool_call" | "semantic_tool_failure";
  metadata?: Record<string, unknown>;
};

type WatchdogConfig = {
  checkEveryMs: number;
  toolStallAfterMs: number;
  modelStallAfterMs: number;
  modelSilentMs: number;
  modelNoAssistantExtraMs: number;
  modelExtraPer1kTokensMs: number;
  modelExtraMaxMs: number;
  maxRetries: number;
  retryCooldownMs: number;
  notify: boolean;
  cronConfigPath: string;
  verifyBeforeRetry: boolean;
  verifierProvider: string;
  verifierModel: string;
  verifierMaxTokens: number;
  verifierInactivityMs: number;
  recoverOnTermination: boolean;
  terminationMode: TerminationMode;
  terminationMinCompleteChars: number;
  terminationVerifyAmbiguous: boolean;
  terminationRequireErrorStop: boolean;
  terminationCooldownMs: number;
  suppressRecoveryOnAbort: boolean;
  traceFile: string;
};

type WatchdogWindowCount = {
  recent: number;
  total: number;
};

const RETRY_PREFIX = "[health-watchdog:auto-retry]";
const CRON_PREFIX = "[health-watchdog:cron]";
const TOOL_GUARD_PREFIX = "[health-watchdog:tool-guard]";
const ENV_PRIMARY_MODEL = (process.env.PI_PRIMARY_MODEL || "").trim();
const VERIFIER_UI_PROGRESS_NOTIFY_MS = parsePositiveInt(
  process.env.PI_HEALTH_WATCHDOG_UI_PROGRESS_NOTIFY_MS,
  1500
);
const WRITE_SCHEMA_WINDOW_MS = parsePositiveInt(process.env.PI_HEALTH_WATCHDOG_WRITE_SCHEMA_WINDOW_MS, 20_000);
const WRITE_SCHEMA_MAX_BEFORE_GUARD = parsePositiveInt(
  process.env.PI_HEALTH_WATCHDOG_WRITE_SCHEMA_MAX_ERRORS,
  2
);
const WRITE_SCHEMA_GUARD_COOLDOWN_MS = parsePositiveInt(
  process.env.PI_HEALTH_WATCHDOG_WRITE_SCHEMA_GUARD_COOLDOWN_MS,
  45_000
);
const FINAL_TAIL_GRACE_MS = parsePositiveInt(process.env.PI_HEALTH_WATCHDOG_FINAL_TAIL_GRACE_MS, 15_000);
// Hard cap: the final-tail-pending state cannot persist beyond this duration,
// even if new tool-use events keep resetting the grace timer.
const FINAL_TAIL_HARD_CAP_MS = parsePositiveInt(process.env.PI_HEALTH_WATCHDOG_FINAL_TAIL_HARD_CAP_MS, 60_000);

const DEFAULT_CONFIG: WatchdogConfig = {
  checkEveryMs: 5_000,
  toolStallAfterMs: 300_000,
  modelStallAfterMs: 1_200_000,
  modelSilentMs: 20_000,
  modelNoAssistantExtraMs: 300_000,
  modelExtraPer1kTokensMs: 1_500,
  modelExtraMaxMs: 900_000,
  maxRetries: 2,
  retryCooldownMs: 30_000,
  notify: true,
  cronConfigPath: `${homedir()}/.pi/agent/health-watchdog-cron.json`,
  verifyBeforeRetry: true,
  verifierProvider: (process.env.PI_HEALTH_WATCHDOG_VERIFIER_PROVIDER || "").trim() || "",  // empty = resolve from ctx at call time
  verifierModel: ENV_PRIMARY_MODEL,
  verifierMaxTokens: 120,
  verifierInactivityMs: 20_000,
  recoverOnTermination: true,
  terminationMode: "balanced",
  terminationMinCompleteChars: 900,
  terminationVerifyAmbiguous: true,
  terminationRequireErrorStop: true,
  terminationCooldownMs: 10_000,
  suppressRecoveryOnAbort: true,
  traceFile: `${homedir()}/.pi/agent/health-watchdog.jsonl`,
};

const PRIOR_COMPLETE_MAX_AGE_MS = 15_000;
const WATCHDOG_COMMAND_WINDOW_MS = parsePositiveInt(process.env.PI_WATCHDOG_COMMAND_WINDOW_MS, 900_000);

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

function readRecentWatchdogEvents(filePath: string, maxLines = 500): any[] {
  try {
    if (!filePath || !fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    return raw
      .split("\n")
      .filter(Boolean)
      .slice(-maxLines)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function makeWindowCount(): WatchdogWindowCount {
  return { recent: 0, total: 0 };
}

function bumpWindowCount(counter: WatchdogWindowCount, inRecentWindow: boolean): void {
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

function analyzeWatchdogEvents(events: any[], nowMs: number, windowMs: number) {
  const pseudoToolCalls = makeWindowCount();
  const semanticToolFailures = makeWindowCount();
  const retries = makeWindowCount();
  const recoveries = makeWindowCount();
  const suppressions = makeWindowCount();
  const verifierErrors = makeWindowCount();

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
      default:
        break;
    }
  }

  const recentEvents = events
    .filter((event) => [
      "pseudo_tool_call_detected",
      "semantic_tool_failure_detected",
      "retry_triggered",
      "termination_recovery_triggered",
      "termination_recovery_suppressed",
      "verifier_error",
      "termination_verifier_error",
    ].includes(event?.type))
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
    recentEvents,
  };
}

function isTerminationLike(stopReason: unknown, summary: string): boolean {
  const reason = typeof stopReason === "string" ? stopReason.trim().toLowerCase() : "";
  const abnormalReasons = ["terminated", "abort", "aborted", "cancel", "cancelled", "interrupted", "error"];
  if (abnormalReasons.some((token) => reason.includes(token))) return true;

  const text = summary.replace(/\s+/g, " ").trim().toLowerCase();
  if (!text) return false;
  return (
    text === "terminated" ||
    text.startsWith("error: terminated") ||
    text.startsWith("operation aborted") ||
    text.startsWith("error: operation aborted")
  );
}

function isErrorLikeStopReason(stopReason: unknown): boolean {
  const reason = typeof stopReason === "string" ? stopReason.trim().toLowerCase() : "";
  return ["error", "abort", "aborted", "terminated", "cancel", "cancelled"].some((token) => reason.includes(token));
}

function hashText(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function normalizeSummary(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function hasUnbalancedCodeFence(text: string): boolean {
  const matches = text.match(/```/g);
  return Array.isArray(matches) && matches.length % 2 === 1;
}

function isLikelyClosedResponse(text: string): boolean {
  const normalized = normalizeSummary(text);
  if (!normalized) return false;
  if (hasUnbalancedCodeFence(normalized)) return false;
  if (/```\s*$/.test(normalized)) return true;
  if (/[.!?]["')\]]?\s*$/.test(normalized)) return true;
  if (/\b(complete|done|finished|summary)[:]?\s*$/i.test(normalized)) return true;
  return false;
}

function containsPseudoToolCallText(text: string): boolean {
  const normalized = normalizeSummary(text).toLowerCase();
  if (!normalized) return false;
  const markers = [
    "<tool_call>",
    "</tool_call>",
    "<function=",
    "<function>",
    "<parameter=command>",
    "<parameter>",
    "</function>",
    "</parameter>",
  ];
  const hasMarkup = markers.some((marker) => normalized.includes(marker));
  const hasPlanningLead =
    normalized.includes("let me ") ||
    normalized.includes("i'll ") ||
    normalized.includes("i will ") ||
    normalized.includes("now let me ");
  return hasMarkup || (hasPlanningLead && (normalized.includes("<tool_call>") || normalized.includes("<function=")));
}

function isSemanticToolFailureText(text: string): boolean {
  const normalized = normalizeSummary(text).toLowerCase();
  if (!normalized) return false;
  const signals = [
    "[error]",
    "status command failed",
    "failed:",
    "command not found",
    "timed out",
    "awaitable timed out",
    "no such file or directory",
    "permission denied",
    "traceback (most recent call last)",
    "error:",
  ];
  return signals.some((signal) => normalized.includes(signal));
}

function summarizeToolResult(result: any): string {
  if (typeof result === "string") return result;
  if (!result) return "";
  if (typeof result.stdout === "string" && result.stdout.trim()) return result.stdout;
  if (typeof result.stderr === "string" && result.stderr.trim()) return result.stderr;
  if (typeof result.output === "string" && result.output.trim()) return result.output;
  if (Array.isArray(result.content)) return extractText(result.content);
  try {
    return JSON.stringify(result);
  } catch {
    return "";
  }
}

function assessTerminationSummary(
  summary: string,
  minCompleteChars: number
): { state: "complete" | "incomplete" | "ambiguous"; reason: string } {
  const normalized = normalizeSummary(summary);
  const lower = normalized.toLowerCase();

  if (!normalized) return { state: "incomplete", reason: "empty_summary" };
  if (
    lower === "terminated" ||
    lower.startsWith("error: terminated") ||
    lower.startsWith("operation aborted") ||
    lower.startsWith("error: operation aborted")
  ) {
    return { state: "incomplete", reason: "explicit_termination_text" };
  }
  if (hasUnbalancedCodeFence(normalized)) {
    return { state: "incomplete", reason: "unbalanced_code_fence" };
  }
  if (/[,:;\-]\s*$/.test(normalized) || /\b(and|or|but|with|to|for|because)\s*$/i.test(normalized)) {
    return { state: "incomplete", reason: "abrupt_tail" };
  }

  if (normalized.length >= minCompleteChars) {
    if (/[.!?]["')\]]?\s*$/.test(normalized) || normalized.endsWith("```")) {
      return { state: "complete", reason: "long_closed_response" };
    }
    if (normalized.length >= Math.floor(minCompleteChars * 1.6)) {
      return { state: "complete", reason: "very_long_response" };
    }
  }

  if (normalized.length < Math.max(180, Math.floor(minCompleteChars * 0.35))) {
    return { state: "incomplete", reason: "too_short" };
  }

  return { state: "ambiguous", reason: "needs_verifier" };
}

function parseTerminationMode(value: string | undefined, fallback: TerminationMode): TerminationMode {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "aggressive" || normalized === "balanced") return normalized;
  return fallback;
}

function extractToolErrorText(event: any): string {
  if (typeof event?.error === "string" && event.error.trim()) return event.error;
  if (typeof event?.message === "string" && event.message.trim()) return event.message;
  if (typeof event?.stderr === "string" && event.stderr.trim()) return event.stderr;
  if (event?.error && typeof event.error === "object") {
    try {
      return JSON.stringify(event.error);
    } catch {
      return "";
    }
  }
  return "";
}

function isWriteSchemaValidationError(errorText: string): boolean {
  const lower = errorText.toLowerCase();
  return (
    lower.includes("validation failed for tool \"write\"") &&
    lower.includes("must have required property 'path'") &&
    lower.includes("must have required property 'content'")
  );
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
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

function parseDurationToMs(input: string): number | null {
  const trimmed = input.trim();
  const match = trimmed.match(/^(\d+)(ms|s|m|h)$/i);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2].toLowerCase();
  if (unit === "ms") return value;
  if (unit === "s") return value * 1_000;
  if (unit === "m") return value * 60_000;
  if (unit === "h") return value * 3_600_000;
  return null;
}

function normalizeCronJob(raw: Partial<CronJob> & { every?: string; everyMs?: number }): CronJob | null {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.name !== "string" || !raw.name.trim()) return null;
  if (typeof raw.prompt !== "string" || !raw.prompt.trim()) return null;

  const everyMsFromString = typeof raw.every === "string" ? parseDurationToMs(raw.every) : null;
  const everyMsFromNumber =
    typeof raw.everyMs === "number" && Number.isFinite(raw.everyMs) && raw.everyMs > 0
      ? Math.floor(raw.everyMs)
      : null;
  const everyMs = everyMsFromNumber ?? everyMsFromString;
  if (!everyMs || everyMs <= 0) return null;

  let deliverMode: CronDeliverMode = "followUp";
  if (raw.deliverMode === "immediate" || raw.deliverMode === "followUp") {
    deliverMode = raw.deliverMode;
  }

  return {
    name: raw.name.trim(),
    prompt: raw.prompt.trim(),
    everyMs,
    enabled: raw.enabled !== false,
    deliverWhenBusy: raw.deliverWhenBusy === true,
    deliverMode,
  };
}

function loadCronJobs(path: string): CronJob[] {
  if (!fs.existsSync(path)) return [];

  try {
    const raw = fs.readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as CronFileShape | Array<Partial<CronJob> & { every?: string; everyMs?: number }>;
    const jobs = Array.isArray(parsed) ? parsed : parsed.jobs;
    if (!Array.isArray(jobs)) return [];

    const normalized = jobs
      .map((job) => normalizeCronJob(job))
      .filter((job): job is CronJob => job !== null)
      .filter((job) => job.enabled);

    return normalized;
  } catch (error) {
    console.error("[health-watchdog] Failed to parse cron config:", error);
    return [];
  }
}

function makeConfigFromEnv(): WatchdogConfig {
  const legacyStallMs = parsePositiveInt(
    process.env.PI_HEALTH_WATCHDOG_STALL_MS,
    DEFAULT_CONFIG.toolStallAfterMs
  );

  return {
    checkEveryMs: parsePositiveInt(process.env.PI_HEALTH_WATCHDOG_CHECK_MS, DEFAULT_CONFIG.checkEveryMs),
    toolStallAfterMs: parsePositiveInt(
      process.env.PI_HEALTH_WATCHDOG_TOOL_STALL_MS,
      legacyStallMs
    ),
    modelStallAfterMs: parsePositiveInt(
      process.env.PI_HEALTH_WATCHDOG_MODEL_STALL_MS,
      DEFAULT_CONFIG.modelStallAfterMs
    ),
    modelSilentMs: parsePositiveInt(
      process.env.PI_HEALTH_WATCHDOG_MODEL_SILENT_MS,
      DEFAULT_CONFIG.modelSilentMs
    ),
    modelNoAssistantExtraMs: parsePositiveInt(
      process.env.PI_HEALTH_WATCHDOG_MODEL_NO_ASSISTANT_EXTRA_MS,
      DEFAULT_CONFIG.modelNoAssistantExtraMs
    ),
    modelExtraPer1kTokensMs: parsePositiveInt(
      process.env.PI_HEALTH_WATCHDOG_MODEL_EXTRA_PER_1K_TOKENS_MS,
      DEFAULT_CONFIG.modelExtraPer1kTokensMs
    ),
    modelExtraMaxMs: parsePositiveInt(
      process.env.PI_HEALTH_WATCHDOG_MODEL_EXTRA_MAX_MS,
      DEFAULT_CONFIG.modelExtraMaxMs
    ),
    maxRetries: parsePositiveInt(process.env.PI_HEALTH_WATCHDOG_MAX_RETRIES, DEFAULT_CONFIG.maxRetries),
    retryCooldownMs: parsePositiveInt(
      process.env.PI_HEALTH_WATCHDOG_RETRY_COOLDOWN_MS,
      DEFAULT_CONFIG.retryCooldownMs
    ),
    notify: parseBoolean(process.env.PI_HEALTH_WATCHDOG_NOTIFY, DEFAULT_CONFIG.notify),
    cronConfigPath: process.env.PI_HEALTH_WATCHDOG_CRON_FILE || DEFAULT_CONFIG.cronConfigPath,
    verifyBeforeRetry: parseBoolean(
      process.env.PI_HEALTH_WATCHDOG_VERIFY_BEFORE_RETRY,
      DEFAULT_CONFIG.verifyBeforeRetry
    ),
    verifierProvider: process.env.PI_HEALTH_WATCHDOG_VERIFIER_PROVIDER || DEFAULT_CONFIG.verifierProvider,
    verifierModel: process.env.PI_HEALTH_WATCHDOG_VERIFIER_MODEL || DEFAULT_CONFIG.verifierModel,
    verifierMaxTokens: parsePositiveInt(
      process.env.PI_HEALTH_WATCHDOG_VERIFIER_MAX_TOKENS,
      DEFAULT_CONFIG.verifierMaxTokens
    ),
    verifierInactivityMs: parsePositiveInt(
      process.env.PI_HEALTH_WATCHDOG_VERIFIER_INACTIVITY_MS,
      DEFAULT_CONFIG.verifierInactivityMs
    ),
    recoverOnTermination: parseBoolean(
      process.env.PI_HEALTH_WATCHDOG_RECOVER_ON_TERMINATION,
      DEFAULT_CONFIG.recoverOnTermination
    ),
    terminationMode: parseTerminationMode(
      process.env.PI_HEALTH_WATCHDOG_TERMINATION_MODE,
      DEFAULT_CONFIG.terminationMode
    ),
    terminationMinCompleteChars: parsePositiveInt(
      process.env.PI_HEALTH_WATCHDOG_TERMINATION_MIN_COMPLETE_CHARS,
      DEFAULT_CONFIG.terminationMinCompleteChars
    ),
    terminationVerifyAmbiguous: parseBoolean(
      process.env.PI_HEALTH_WATCHDOG_TERMINATION_VERIFY_AMBIGUOUS,
      DEFAULT_CONFIG.terminationVerifyAmbiguous
    ),
    terminationRequireErrorStop: parseBoolean(
      process.env.PI_HEALTH_WATCHDOG_TERMINATION_REQUIRE_ERROR_STOP,
      DEFAULT_CONFIG.terminationRequireErrorStop
    ),
    terminationCooldownMs: parsePositiveInt(
      process.env.PI_HEALTH_WATCHDOG_TERMINATION_COOLDOWN_MS,
      DEFAULT_CONFIG.terminationCooldownMs
    ),
    suppressRecoveryOnAbort: parseBoolean(
      process.env.PI_HEALTH_WATCHDOG_SUPPRESS_RECOVERY_ON_ABORT,
      DEFAULT_CONFIG.suppressRecoveryOnAbort
    ),
    traceFile: process.env.PI_HEALTH_WATCHDOG_TRACE_FILE || DEFAULT_CONFIG.traceFile,
  };
}

export default function healthWatchdogExtension(pi: ExtensionAPI): void {
  const config = makeConfigFromEnv();

  let activePrompt = "";
  let agentRunning = false;
  let lastProgressAt = Date.now();
  let lastRetryAt = 0;
  let retryCount = 0;
  let recovering = false;
  let turnRunning = false;
  let toolRunning = false;
  let turnStartedAt = 0;
  let turnStartContextTokens = 0;
  let assistantMessageStartedAt = 0;
  let lastToolProgressAt = 0;
  let verifierUnavailableNotified = false;
  let verifierInFlight = false;
  let pendingTermination: TerminationCandidate | null = null;
  let lastTerminationSignatureRetried = "";
  let latestUserPromptAt = 0;
  let lastAssistantSummaryInTurn = "";
  let lastAssistantSummaryAt = 0;
  let lastStableAssistantSummary = "";
  let lastStableAssistantAt = 0;
  let writeSchemaErrorCount = 0;
  let writeSchemaWindowStartedAt = 0;
  let lastWriteSchemaGuardAt = 0;
  let finalTailPending = false;
  let finalTailStartedAt = 0;
  let finalTailFirstActivatedAt = 0; // tracks the very first activation, not reset by re-entries
  let finalTailTimer: ReturnType<typeof setTimeout> | null = null;
  let queuedWriteSchemaGuard = false;
  let queuedWriteSchemaErrorText = "";

  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  const cronTimers: Array<ReturnType<typeof setInterval>> = [];

  const cronQueued = new Set<string>();

  function notify(ctx: any, message: string, type: "info" | "warning" | "error" = "info"): void {
    if (!config.notify) return;
    if (!ctx?.hasUI) return;
    ctx.ui.notify(message, type);
  }

  function setWatchdogStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const t = ctx.ui.theme;
    const retries = t.fg("dim", ` r:${retryCount}/${config.maxRetries}`);
    const resolvedVerifier = resolveVerifierModel(ctx)?.id || config.verifierModel || resolvePrimaryModelId(ctx) || "auto";
    ctx.ui.setStatus(
      "watchdog",
      `${t.fg("dim", "watchdog:")}${t.fg("accent", "on")}${retries}${t.fg("dim", ` v:${resolvedVerifier}`)}`
    );
  }

  function trace(type: string, payload: Record<string, unknown> = {}): void {
    if (!config.traceFile) return;
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), type, ...payload });
      fs.appendFileSync(config.traceFile, `${line}\n`, "utf-8");
    } catch {
      // Ignore trace file write errors.
    }
  }

  function touch(): void {
    lastProgressAt = Date.now();
  }

  function clearWatchdog(): void {
    if (!watchdogTimer) return;
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }

  function clearCronTimers(): void {
    while (cronTimers.length > 0) {
      const timer = cronTimers.pop();
      if (timer) clearInterval(timer);
    }
    cronQueued.clear();
  }

  function clearFinalTailTimer(): void {
    if (!finalTailTimer) return;
    clearTimeout(finalTailTimer);
    finalTailTimer = null;
  }

  function resolveFinalTail(reason: string): void {
    if (!finalTailPending) return;
    const elapsedMs = finalTailStartedAt > 0 ? Date.now() - finalTailStartedAt : -1;
    const totalElapsedMs = finalTailFirstActivatedAt > 0 ? Date.now() - finalTailFirstActivatedAt : -1;
    trace("final_tail_resolved", { reason, elapsedMs, totalElapsedMs });
    finalTailPending = false;
    finalTailStartedAt = 0;
    finalTailFirstActivatedAt = 0;
    clearFinalTailTimer();
  }

  function dispatchWriteSchemaGuardPrompt(ctx: ExtensionContext, errorText: string): void {
    const now = Date.now();
    if (!activePrompt.trim()) {
      trace("write_schema_guard_suppressed", { reason: "no_active_prompt" });
      return;
    }

    if (now - lastWriteSchemaGuardAt < WRITE_SCHEMA_GUARD_COOLDOWN_MS) {
      trace("write_schema_guard_suppressed", {
        reason: "cooldown",
        sinceMs: now - lastWriteSchemaGuardAt,
      });
      return;
    }

    lastWriteSchemaGuardAt = now;
    writeSchemaErrorCount = 0;
    writeSchemaWindowStartedAt = now;

    trace("write_schema_guard_triggered", {
      cooldownMs: WRITE_SCHEMA_GUARD_COOLDOWN_MS,
      maxErrors: WRITE_SCHEMA_MAX_BEFORE_GUARD,
      finalTailPending,
      message: errorText.slice(0, 220),
    });

    notify(ctx, "Health watchdog: detected repeated invalid write tool calls. Injecting corrective continuation.", "warning");

    const guardPrompt = [
      `${TOOL_GUARD_PREFIX} write-schema`,
      "The previous attempt repeated invalid write tool calls and likely got truncated.",
      "Continue from the last stable point.",
      "If using write, call it with strict JSON arguments containing both path and content.",
      "Example: {\"path\":\"/absolute/path/file.md\",\"content\":\"...\"}",
      "Do not call write with empty arguments.",
      `Original user request: ${activePrompt}`,
    ].join("\n");

    try {
      if (ctx.isIdle()) {
        pi.sendUserMessage(guardPrompt);
      } else {
        pi.sendUserMessage(guardPrompt, { deliverAs: "followUp" });
      }
      touch();
    } catch (error) {
      console.error("[health-watchdog] failed to send write-schema guard prompt:", error);
    }
  }

  function startFinalTailWatch(ctx: ExtensionContext, source: string): void {
    const now = Date.now();

    // Track when the final-tail-pending state was FIRST activated.
    // This survives re-entries from repeated tool-use events.
    if (!finalTailPending || finalTailFirstActivatedAt === 0) {
      finalTailFirstActivatedAt = now;
    }

    // Hard cap: if we've been in final-tail-pending for too long, refuse to
    // restart the grace timer.  Let the current timer expire (or fire immediately
    // if none is running) so the watchdog can act.
    const totalElapsed = now - finalTailFirstActivatedAt;
    if (totalElapsed >= FINAL_TAIL_HARD_CAP_MS) {
      trace("final_tail_hard_cap_reached", {
        source,
        totalElapsedMs: totalElapsed,
        hardCapMs: FINAL_TAIL_HARD_CAP_MS,
      });
      // Force-expire the pending state immediately.
      finalTailPending = false;
      finalTailStartedAt = 0;
      finalTailFirstActivatedAt = 0;
      clearFinalTailTimer();
      if (pendingTermination) {
        const candidate = pendingTermination;
        pendingTermination = null;
        void maybeRecoverFromTermination(ctx, candidate, "final_tail_hard_cap");
      }
      if (queuedWriteSchemaGuard) {
        const queuedError = queuedWriteSchemaErrorText || "queued write-schema guard";
        queuedWriteSchemaGuard = false;
        queuedWriteSchemaErrorText = "";
        dispatchWriteSchemaGuardPrompt(ctx, queuedError);
      }
      return;
    }

    finalTailPending = true;
    finalTailStartedAt = now;
    clearFinalTailTimer();
    trace("final_tail_pending", { source, graceMs: FINAL_TAIL_GRACE_MS, totalElapsedMs: totalElapsed, hardCapMs: FINAL_TAIL_HARD_CAP_MS });
    finalTailTimer = setTimeout(() => {
      if (!finalTailPending) return;
      const elapsedMs = finalTailStartedAt > 0 ? Date.now() - finalTailStartedAt : FINAL_TAIL_GRACE_MS;
      finalTailPending = false;
      finalTailStartedAt = 0;
      finalTailFirstActivatedAt = 0;
      clearFinalTailTimer();
      trace("final_tail_timeout", { source, elapsedMs, queuedWriteSchemaGuard });
      if (pendingTermination) {
        const candidate = pendingTermination;
        pendingTermination = null;
        void maybeRecoverFromTermination(ctx, candidate, "final_tail_timeout");
      }
      if (queuedWriteSchemaGuard) {
        const queuedError = queuedWriteSchemaErrorText || "queued write-schema guard";
        queuedWriteSchemaGuard = false;
        queuedWriteSchemaErrorText = "";
        dispatchWriteSchemaGuardPrompt(ctx, queuedError);
      }
    }, FINAL_TAIL_GRACE_MS);
  }

  function resolveVerifierModel(ctx: ExtensionContext): any {
    const provider = config.verifierProvider || resolveActiveProvider(ctx);
    const sc = getSidecarConfig(provider);
    const lookupProvider = config.verifierProvider || resolveSidecarProvider(provider);
    const primaryModelId = resolvePrimaryModelId(ctx);
    const verifierModelId = sc.verifier || primaryModelId;
    const candidates = [config.verifierModel, verifierModelId, primaryModelId]
      .map((id) => (typeof id === "string" ? id.trim() : ""))
      .filter((id, index, arr) => id.length > 0 && arr.indexOf(id) === index);

    for (const id of candidates) {
      const model = ctx.modelRegistry.find(lookupProvider, id);
      if (model) return model;
    }
    return null;
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

  function parseVerifierDecision(text: string): "wait" | "retry" | null {
    const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "");
    try {
      const parsed = JSON.parse(cleaned) as { decision?: string };
      if (parsed.decision === "wait" || parsed.decision === "retry") return parsed.decision;
      return null;
    } catch {
      return null;
    }
  }

  async function shouldRetryModelStall(
    ctx: ExtensionContext,
    turnElapsedMs: number,
    effectiveModelStallMs: number
  ): Promise<boolean> {
    if (!config.verifyBeforeRetry) return true;

    const model = resolveVerifierModel(ctx);
    if (!model) {
      trace("verifier_unavailable", { reason: "model_not_found" });
      if (!verifierUnavailableNotified) {
        verifierUnavailableNotified = true;
        notify(ctx, "Health watchdog verifier model unavailable; using timeout-only behavior.", "warning");
      }
      return true;
    }

    const apiKey = await ctx.modelRegistry.getApiKey(model);
    if (!apiKey) return true;
    trace("verifier_attempt", {
      modelId: model.id,
      turnElapsedMs,
      effectiveModelStallMs,
      turnStartContextTokens,
      assistantMessageStarted: assistantMessageStartedAt > 0,
      retryCount,
      maxRetries: config.maxRetries,
    });

    let progressTimer: ReturnType<typeof setTimeout> | null = null;
    let longRunningNotified = false;
    if (ctx.hasUI) {
      ctx.ui.setStatus("watchdog-verifier", `verifier:${model.id}`);
      ctx.ui.setWorkingMessage(`Watchdog verifier running (${model.id})...`);
      progressTimer = setTimeout(() => {
        ctx.ui.notify(`Watchdog verifier running (${model.id})...`);
        longRunningNotified = true;
      }, VERIFIER_UI_PROGRESS_NOTIFY_MS);
    }

    const verificationPrompt = [
      "You are a watchdog verifier deciding whether an LLM run is likely still progressing.",
      "Return strict JSON only: {\"decision\":\"wait\"|\"retry\",\"reason\":\"short\"}",
      "Conservative policy: choose wait when uncertain.",
      `Signal.turnElapsedMs=${turnElapsedMs}`,
      `Signal.effectiveModelStallMs=${effectiveModelStallMs}`,
      `Signal.turnStartContextTokens=${turnStartContextTokens}`,
      `Signal.assistantMessageStarted=${assistantMessageStartedAt > 0}`,
      `Signal.lastToolProgressAgeMs=${lastToolProgressAt > 0 ? Date.now() - lastToolProgressAt : -1}`,
      `Signal.retryCount=${retryCount}`,
      `Signal.maxRetries=${config.maxRetries}`,
      `Signal.promptChars=${activePrompt.length}`,
      "Decision:",
    ].join("\n");

    try {
      const response = await completeWithInactivityTimeout(
        model,
        {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: verificationPrompt }],
              timestamp: Date.now(),
            },
          ],
        },
        { apiKey, maxTokens: config.verifierMaxTokens },
        config.verifierInactivityMs
      );

      const { text } = extractResponseText(response, 2);
      const decision = parseVerifierDecision(text);
      if (decision === "wait") {
        trace("verifier_decision", { decision: "wait", modelId: model.id });
        notify(ctx, "Health watchdog verifier suggests waiting; skip retry for now.");
        return false;
      }

      trace("verifier_decision", { decision: "retry", modelId: model.id });
      return true;
    } catch (error) {
      trace("verifier_error", { message: error instanceof Error ? error.message : "unknown" });
      console.error("[health-watchdog] verifier check failed:", error);
      notify(ctx, "Health watchdog verifier error; waiting instead of forcing retry.", "warning");
      return false;
    } finally {
      if (progressTimer) clearTimeout(progressTimer);
      if (ctx.hasUI) {
        ctx.ui.setWorkingMessage();
        ctx.ui.setStatus("watchdog-verifier", undefined);
        if (longRunningNotified) {
          ctx.ui.notify(`Watchdog verifier finished (${model.id}).`);
        }
      }
    }
  }

  async function tryRecover(ctx: any): Promise<void> {
    if (!agentRunning) return;
    if (recovering) return;
    if (verifierInFlight) {
      trace("retry_suppressed_verifier_inflight");
      return;
    }
    if (finalTailPending) {
      trace("retry_suppressed_final_tail_pending", { graceMs: FINAL_TAIL_GRACE_MS });
      return;
    }
    if (!activePrompt.trim()) return;

    const now = Date.now();
    let stalled = false;
    let stallKind: "tool" | "model" = "model";
    let effectiveModelStallMs = config.modelStallAfterMs;

    if (toolRunning && lastToolProgressAt > 0) {
      stalled = now - lastToolProgressAt >= config.toolStallAfterMs;
      stallKind = "tool";
    } else if (turnRunning && turnStartedAt > 0) {
      const contextExtraMs = Math.min(
        Math.floor(Math.max(0, turnStartContextTokens) / 1_000) * config.modelExtraPer1kTokensMs,
        config.modelExtraMaxMs
      );
      const noAssistantExtraMs = assistantMessageStartedAt === 0 ? config.modelNoAssistantExtraMs : 0;
      effectiveModelStallMs = config.modelStallAfterMs + contextExtraMs + noAssistantExtraMs;
      stalled = now - turnStartedAt >= effectiveModelStallMs;
      stallKind = "model";

      const modelSilentForMs = now - lastProgressAt;
      if (stalled && modelSilentForMs < config.modelSilentMs) {
        trace("model_stall_suppressed", {
          reason: "recent_progress",
          modelSilentForMs,
          modelSilentMs: config.modelSilentMs,
          turnElapsedMs: now - turnStartedAt,
          effectiveModelStallMs,
        });
        return;
      }
    }

    if (!stalled) return;

    const cooldownElapsed = now - lastRetryAt >= config.retryCooldownMs;
    if (!cooldownElapsed) return;

    if (stallKind === "model" && turnStartedAt > 0) {
      const turnElapsedMs = now - turnStartedAt;
      verifierInFlight = true;
      const shouldRetry = await shouldRetryModelStall(ctx, turnElapsedMs, effectiveModelStallMs).finally(() => {
        verifierInFlight = false;
      });
      if (!shouldRetry) {
        touch();
        return;
      }
    }

    if (retryCount >= config.maxRetries) {
      trace("max_retries_reached", {
        retryCount,
        maxRetries: config.maxRetries,
        stallKind,
      });
      notify(
        ctx,
        `Health watchdog: max retries (${config.maxRetries}) exhausted. Attempting emergency compaction to free context.`,
        "warning"
      );

      // Try to force a compaction so the session isn't permanently bloated.
      // This is a best-effort recovery — if compaction fails, we still stop
      // retrying but keep the watchdog alive so it can detect future stalls
      // if the user sends a new prompt.
      try {
        ctx.compact({
          customInstructions:
            "Emergency compaction after watchdog max retries. Aggressively reduce context. Preserve only: current objective, file paths with unsaved changes, and final error state.",
          onComplete: () => {
            trace("emergency_compaction_complete");
            notify(ctx, "Emergency compaction after max retries complete.");
          },
          onError: (error: Error) => {
            trace("emergency_compaction_error", { message: error.message });
            notify(ctx, `Emergency compaction failed: ${error.message}`, "error");
          },
        });
      } catch (compactError) {
        trace("emergency_compaction_exception", {
          message: compactError instanceof Error ? compactError.message : "unknown",
        });
      }

      // Don't clearWatchdog() — keep stall detection alive for future prompts.
      // Just stop retrying this particular prompt.
      return;
    }

    retryCount += 1;
    lastRetryAt = Date.now();
    recovering = true;
    setWatchdogStatus(ctx);
    trace("retry_triggered", {
      stallKind,
      retryCount,
      maxRetries: config.maxRetries,
      effectiveModelStallMs,
    });

    notify(
      ctx,
      stallKind === "model"
        ? `Health watchdog: model stall detected (>${Math.round(effectiveModelStallMs / 1000)}s), retry ${retryCount}/${config.maxRetries}.`
        : `Health watchdog: tool stall detected, retry ${retryCount}/${config.maxRetries}.`,
      "warning"
    );

    try {
      await ctx.abort();
    } catch (error) {
      console.error("[health-watchdog] abort failed:", error);
    }

    const retryPrompt = [
      `${RETRY_PREFIX} ${retryCount}/${config.maxRetries}`,
      `The previous run appears stalled (${stallKind}). Continue safely from where you left off.`,
      `Original user request: ${activePrompt}`,
    ].join("\n");

    try {
      if (ctx.isIdle()) {
        pi.sendUserMessage(retryPrompt);
      } else {
        pi.sendUserMessage(retryPrompt, { deliverAs: "followUp" });
      }
      touch();
    } catch (error) {
      console.error("[health-watchdog] failed to send retry prompt:", error);
    } finally {
      recovering = false;
    }
  }

  function buildTerminationCandidate(
    stopReason: unknown,
    summary: string,
    priorAssistantChars = 0,
    priorAssistantAgeMs = -1,
    priorAssistantClosed = false,
    extras: Partial<Pick<TerminationCandidate, "kind" | "metadata">> = {}
  ): TerminationCandidate {
    const normalizedSummary = normalizeSummary(summary);
    const normalizedStopReason = typeof stopReason === "string" ? stopReason : "unknown";
    const signature = hashText(
      `${activePrompt.slice(0, 1000)}|${normalizedStopReason}|${normalizedSummary.slice(-700)}`
    );
    return {
      stopReason: normalizedStopReason,
      summary: normalizedSummary,
      assistantChars: normalizedSummary.length,
      priorAssistantChars,
      priorAssistantAgeMs,
      priorAssistantClosed,
      detectedAt: Date.now(),
      signature,
      kind: extras.kind,
      metadata: extras.metadata,
    };
  }

  function looksLikePostCompletionTermination(candidate: TerminationCandidate): boolean {
    const minPriorChars = Math.max(280, Math.floor(config.terminationMinCompleteChars * 0.45));
    return (
      candidate.assistantChars <= 220 &&
      candidate.priorAssistantChars >= minPriorChars &&
      candidate.priorAssistantClosed &&
      candidate.priorAssistantAgeMs >= 0 &&
      candidate.priorAssistantAgeMs <= PRIOR_COMPLETE_MAX_AGE_MS
    );
  }

  async function shouldRetryTerminationAmbiguous(
    ctx: ExtensionContext,
    candidate: TerminationCandidate,
    assessmentReason: string
  ): Promise<boolean> {
    if (!config.verifyBeforeRetry || !config.terminationVerifyAmbiguous) {
      trace("termination_verifier_skipped", {
        reason: "verification_disabled",
        assessmentReason,
      });
      return false;
    }

    const model = resolveVerifierModel(ctx);
    if (!model) {
      trace("termination_verifier_skipped", { reason: "model_not_found", assessmentReason });
      return false;
    }

    const apiKey = await ctx.modelRegistry.getApiKey(model);
    if (!apiKey) {
      trace("termination_verifier_skipped", { reason: "missing_api_key", modelId: model.id, assessmentReason });
      return false;
    }

    const prompt = [
      "You are a watchdog verifier deciding if an LLM answer was cut off and should be retried.",
      "Return strict JSON only: {\"decision\":\"wait\"|\"retry\",\"reason\":\"short\"}",
      "Conservative policy: choose wait if the answer appears complete.",
      `Signal.stopReason=${candidate.stopReason}`,
      `Signal.assistantChars=${candidate.assistantChars}`,
      `Signal.assessment=${assessmentReason}`,
      `Signal.retryCount=${retryCount}`,
      `Signal.maxRetries=${config.maxRetries}`,
      `Signal.summaryTail=${candidate.summary.slice(Math.max(0, candidate.summary.length - 700))}`,
      "Decision:",
    ].join("\n");

    trace("termination_verifier_attempt", {
      modelId: model.id,
      assessmentReason,
      assistantChars: candidate.assistantChars,
    });

    try {
      verifierInFlight = true;
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
        { apiKey, maxTokens: config.verifierMaxTokens },
        config.verifierInactivityMs
      );

      const { text } = extractResponseText(response, 2);
      const decision = parseVerifierDecision(text);
      if (decision === "retry") {
        trace("termination_verifier_decision", { decision: "retry", modelId: model.id });
        return true;
      }

      trace("termination_verifier_decision", { decision: "wait", modelId: model.id });
      return false;
    } catch (error) {
      trace("termination_verifier_error", {
        message: error instanceof Error ? error.message : "unknown",
      });
      return false;
    } finally {
      verifierInFlight = false;
    }
  }

  async function maybeRecoverFromTermination(
    ctx: ExtensionContext,
    candidate: TerminationCandidate,
    source: "message_end" | "turn_end" | "agent_end" | "proof" | "final_tail_timeout"
  ): Promise<void> {
    if (!config.recoverOnTermination) return;
    if (!activePrompt.trim()) return;
    if (recovering || verifierInFlight) return;
    if (finalTailPending && source !== "proof") {
      trace("termination_recovery_suppressed", {
        reason: "final_tail_pending",
        source,
        stopReason: candidate.stopReason,
      });
      return;
    }

    // Suppress recovery for user-initiated aborts.  When the stop reason is
    // literally "aborted"/"abort"/"cancel"/"cancelled" it is almost always the
    // user pressing Ctrl+C, not a model error.  Retrying in that case wastes
    // context and re-triggers work the user explicitly stopped.
    if (config.suppressRecoveryOnAbort) {
      const userAbortReasons = ["aborted", "abort", "cancel", "cancelled"];
      const lower = (candidate.stopReason || "").trim().toLowerCase();
      if (userAbortReasons.includes(lower)) {
        trace("termination_recovery_suppressed", {
          reason: "likely_user_initiated_abort",
          source,
          stopReason: candidate.stopReason,
        });
        return;
      }
    }

    if (latestUserPromptAt > candidate.detectedAt) {
      trace("termination_recovery_suppressed", {
        reason: "newer_user_prompt",
        source,
        stopReason: candidate.stopReason,
      });
      return;
    }

    if (lastTerminationSignatureRetried === candidate.signature) {
      trace("termination_recovery_suppressed", {
        reason: "duplicate_signature",
        source,
        stopReason: candidate.stopReason,
      });
      return;
    }

    const now = Date.now();
    if (now - lastRetryAt < Math.max(config.retryCooldownMs, config.terminationCooldownMs)) {
      trace("termination_recovery_suppressed", {
        reason: "cooldown",
        source,
        stopReason: candidate.stopReason,
      });
      return;
    }

    if (retryCount >= config.maxRetries) {
      trace("termination_recovery_suppressed", {
        reason: "max_retries",
        source,
        stopReason: candidate.stopReason,
        retryCount,
      });
      return;
    }

    const forcedKinds = new Set(["pseudo_tool_call", "semantic_tool_failure"]);
    if (
      config.terminationRequireErrorStop &&
      !forcedKinds.has(candidate.kind || "") &&
      !isErrorLikeStopReason(candidate.stopReason) &&
      !isTerminationLike(candidate.stopReason, candidate.summary)
    ) {
      trace("termination_recovery_suppressed", {
        reason: "non_error_stop_reason",
        source,
        stopReason: candidate.stopReason,
      });
      return;
    }

    let shouldRetry = false;
    let decisionReason = "aggressive";
    if (forcedKinds.has(candidate.kind || "")) {
      shouldRetry = true;
      decisionReason = candidate.kind || "forced_kind";
    } else if (config.terminationMode === "aggressive") {
      shouldRetry = true;
    } else {
      if (looksLikePostCompletionTermination(candidate)) {
        shouldRetry = false;
        decisionReason = "prior_complete_output";
      } else {
        const assessed = assessTerminationSummary(candidate.summary, config.terminationMinCompleteChars);
        decisionReason = assessed.reason;
        if (assessed.state === "incomplete") {
          shouldRetry = true;
        } else if (assessed.state === "complete") {
          shouldRetry = false;
        } else {
          shouldRetry = await shouldRetryTerminationAmbiguous(ctx, candidate, assessed.reason);
          decisionReason = shouldRetry ? "ambiguous_retry" : "ambiguous_wait";
        }
      }
    }

    trace("termination_decision", {
      source,
      mode: config.terminationMode,
      shouldRetry,
      reason: decisionReason,
      stopReason: candidate.stopReason,
      assistantChars: candidate.assistantChars,
      priorAssistantChars: candidate.priorAssistantChars,
      priorAssistantAgeMs: candidate.priorAssistantAgeMs,
      priorAssistantClosed: candidate.priorAssistantClosed,
    });

    if (!shouldRetry) return;

    retryCount += 1;
    lastRetryAt = now;
    lastTerminationSignatureRetried = candidate.signature;
    recovering = true;
    setWatchdogStatus(ctx);
    trace("termination_recovery_triggered", {
      source,
      stopReason: candidate.stopReason,
      retryCount,
      maxRetries: config.maxRetries,
      summary: candidate.summary.slice(0, 220),
    });

    notify(
      ctx,
      `Health watchdog: detected termination signal, retry ${retryCount}/${config.maxRetries}.`,
      "warning"
    );

    const retryPrompt = [
      `${RETRY_PREFIX} ${retryCount}/${config.maxRetries}`,
      "The previous run terminated and may be incomplete. Continue only unfinished work and avoid repeating completed sections.",
      `Original user request: ${activePrompt}`,
    ].join("\n");

    try {
      if (ctx.isIdle()) {
        pi.sendUserMessage(retryPrompt);
      } else {
        pi.sendUserMessage(retryPrompt, { deliverAs: "followUp" });
      }
      touch();
    } catch (error) {
      console.error("[health-watchdog] failed to send termination recovery prompt:", error);
    } finally {
      recovering = false;
    }
  }

  function handleWriteSchemaError(ctx: ExtensionContext, errorText: string, sendPrompt = true): void {
    const now = Date.now();
    if (writeSchemaWindowStartedAt === 0 || now - writeSchemaWindowStartedAt > WRITE_SCHEMA_WINDOW_MS) {
      writeSchemaWindowStartedAt = now;
      writeSchemaErrorCount = 0;
    }

    writeSchemaErrorCount += 1;
    trace("write_schema_error_detected", {
      count: writeSchemaErrorCount,
      windowMs: WRITE_SCHEMA_WINDOW_MS,
      message: errorText.slice(0, 220),
    });

    if (writeSchemaErrorCount < WRITE_SCHEMA_MAX_BEFORE_GUARD) return;
    if (!sendPrompt) {
      trace("write_schema_guard_triggered", {
        cooldownMs: WRITE_SCHEMA_GUARD_COOLDOWN_MS,
        maxErrors: WRITE_SCHEMA_MAX_BEFORE_GUARD,
        deferred: true,
      });
      return;
    }

    if (finalTailPending) {
      queuedWriteSchemaGuard = true;
      queuedWriteSchemaErrorText = errorText;
      trace("write_schema_guard_suppressed", {
        reason: "final_tail_pending",
        graceMs: FINAL_TAIL_GRACE_MS,
      });
      return;
    }

    dispatchWriteSchemaGuardPrompt(ctx, errorText);
  }

  function startWatchdog(ctx: any): void {
    clearWatchdog();
    watchdogTimer = setInterval(() => {
      void tryRecover(ctx);
    }, config.checkEveryMs);
  }

  function scheduleCronJobs(ctx: any): void {
    clearCronTimers();

    const jobs = loadCronJobs(config.cronConfigPath);
    if (jobs.length === 0) {
      notify(ctx, `Health watchdog: no cron jobs loaded (${config.cronConfigPath}).`);
      return;
    }

    for (const job of jobs) {
      const timer = setInterval(() => {
        const prompt = `${CRON_PREFIX} ${job.name}\n${job.prompt}`;

        if (!ctx.isIdle()) {
          if (!job.deliverWhenBusy) return;
          if (cronQueued.has(job.name)) return;
          cronQueued.add(job.name);
          pi.sendUserMessage(prompt, { deliverAs: job.deliverMode });
          notify(ctx, `Cron queued: ${job.name}`);
          return;
        }

        cronQueued.delete(job.name);
        pi.sendUserMessage(prompt);
        notify(ctx, `Cron triggered: ${job.name}`);
      }, job.everyMs);

      cronTimers.push(timer);
    }

    notify(ctx, `Health watchdog: loaded ${jobs.length} cron job(s).`);
  }

  pi.on("session_start", async (_event, ctx) => {
    const primaryModelId = resolvePrimaryModelId(ctx);
    const verifierModel = resolveVerifierModel(ctx);
    touch();
    retryCount = 0;
    verifierUnavailableNotified = false;
    verifierInFlight = false;
    pendingTermination = null;
    lastTerminationSignatureRetried = "";
    latestUserPromptAt = 0;
    lastAssistantSummaryInTurn = "";
    lastAssistantSummaryAt = 0;
    lastStableAssistantSummary = "";
    lastStableAssistantAt = 0;
    writeSchemaErrorCount = 0;
    writeSchemaWindowStartedAt = 0;
    lastWriteSchemaGuardAt = 0;
    finalTailPending = false;
    finalTailStartedAt = 0;
    finalTailFirstActivatedAt = 0;
    queuedWriteSchemaGuard = false;
    queuedWriteSchemaErrorText = "";
    clearFinalTailTimer();
    trace("session_start", {
      verifyBeforeRetry: config.verifyBeforeRetry,
      primaryModel: primaryModelId || null,
      activeProvider: config.verifierProvider || resolveActiveProvider(ctx),
      verifierModel: config.verifierModel,
      verifierResolvedModel: verifierModel?.id || null,
      recoverOnTermination: config.recoverOnTermination,
      terminationMode: config.terminationMode,
      terminationMinCompleteChars: config.terminationMinCompleteChars,
      terminationVerifyAmbiguous: config.terminationVerifyAmbiguous,
      suppressRecoveryOnAbort: config.suppressRecoveryOnAbort,
      writeSchemaWindowMs: WRITE_SCHEMA_WINDOW_MS,
      writeSchemaMaxBeforeGuard: WRITE_SCHEMA_MAX_BEFORE_GUARD,
      writeSchemaGuardCooldownMs: WRITE_SCHEMA_GUARD_COOLDOWN_MS,
      finalTailGraceMs: FINAL_TAIL_GRACE_MS,
      toolStallAfterMs: config.toolStallAfterMs,
      modelStallAfterMs: config.modelStallAfterMs,
    });
    scheduleCronJobs(ctx);
    setWatchdogStatus(ctx);
    if (config.verifyBeforeRetry && !verifierModel) {
      notify(
        ctx,
        `Health watchdog verifier model unavailable (${config.verifierProvider || "auto"}); retry verification will be skipped.`,
        "warning"
      );
    }
    notify(ctx, "Health watchdog enabled.");
  });

  pi.registerCommand("watchdog-proof", {
    description: "Probe watchdog verifier model",
    handler: async (_args, ctx) => {
      const shouldRetry = await shouldRetryModelStall(
        ctx,
        config.modelStallAfterMs + config.modelNoAssistantExtraMs + 1,
        config.modelStallAfterMs + config.modelNoAssistantExtraMs
      );
      notify(ctx, `Watchdog proof: verifier ${shouldRetry ? "allows retry" : "suggests wait"}.`);
    },
  });

  pi.registerCommand("watchdog-proof-gate", {
    description: "Probe in-flight verifier retry suppression",
    handler: async (_args, ctx) => {
      const snapshot = {
        activePrompt,
        agentRunning,
        retryCount,
        recovering,
        turnRunning,
        toolRunning,
        turnStartedAt,
        turnStartContextTokens,
        assistantMessageStartedAt,
        lastToolProgressAt,
        lastProgressAt,
        lastRetryAt,
      };

      activePrompt = "[watchdog-proof-gate] synthetic prompt";
      agentRunning = true;
      retryCount = 0;
      recovering = false;
      turnRunning = true;
      toolRunning = false;
      turnStartedAt = Date.now() - (config.modelStallAfterMs + config.modelNoAssistantExtraMs + 5_000);
      turnStartContextTokens = 0;
      assistantMessageStartedAt = 0;
      lastToolProgressAt = 0;
      lastProgressAt = Date.now() - (config.modelSilentMs + 2_000);
      lastRetryAt = 0;

      verifierInFlight = true;
      const retriesBefore = retryCount;
      try {
        await tryRecover(ctx);
      } finally {
        verifierInFlight = false;
        activePrompt = snapshot.activePrompt;
        agentRunning = snapshot.agentRunning;
        retryCount = snapshot.retryCount;
        recovering = snapshot.recovering;
        turnRunning = snapshot.turnRunning;
        toolRunning = snapshot.toolRunning;
        turnStartedAt = snapshot.turnStartedAt;
        turnStartContextTokens = snapshot.turnStartContextTokens;
        assistantMessageStartedAt = snapshot.assistantMessageStartedAt;
        lastToolProgressAt = snapshot.lastToolProgressAt;
        lastProgressAt = snapshot.lastProgressAt;
        lastRetryAt = snapshot.lastRetryAt;
      }

      const suppressed = retriesBefore === retryCount;
      notify(
        ctx,
        `Watchdog gate proof: ${suppressed ? "retry suppressed while verifier in-flight" : "unexpected retry"}.`,
        suppressed ? "info" : "warning"
      );
    },
  });

  pi.registerCommand("watchdog-proof-termination", {
    description: "Probe termination-triggered recovery path (incomplete)",
    handler: async (_args, ctx) => {
      const snapshot = {
        activePrompt,
        agentRunning,
        retryCount,
        recovering,
        lastRetryAt,
        latestUserPromptAt,
      };

      activePrompt = "[watchdog-proof-termination] synthetic prompt";
      agentRunning = true;
      recovering = false;
      retryCount = 0;
      lastRetryAt = 0;
      latestUserPromptAt = 0;

      try {
        const candidate = buildTerminationCandidate("aborted", "Error: terminated");
        await maybeRecoverFromTermination(ctx, candidate, "proof");
      } finally {
        activePrompt = snapshot.activePrompt;
        agentRunning = snapshot.agentRunning;
        retryCount = snapshot.retryCount;
        recovering = snapshot.recovering;
        lastRetryAt = snapshot.lastRetryAt;
        latestUserPromptAt = snapshot.latestUserPromptAt;
      }

      notify(ctx, "Watchdog termination proof executed.");
    },
  });

  pi.registerCommand("watchdog-proof-termination-complete", {
    description: "Probe balanced termination suppression for complete answers",
    handler: async (_args, ctx) => {
      const snapshot = {
        activePrompt,
        agentRunning,
        retryCount,
        recovering,
        lastRetryAt,
        latestUserPromptAt,
      };

      activePrompt = "[watchdog-proof-termination-complete] synthetic prompt";
      agentRunning = true;
      recovering = false;
      retryCount = 0;
      lastRetryAt = 0;
      latestUserPromptAt = 0;

      try {
        const completeSummary = (
          "Sunago is novel because it combines adaptive early-exit routing with specialist heads, demonstrating a speed-accuracy tradeoff improvement while preserving classification quality. " +
          "Compared with prior flat or offline-heavy systems, it keeps real-time operation and interpretable routing decisions. " +
          "It also frames novelty as an architectural contribution with measurable latency and F1 behavior across easy and hard traffic classes, and it explicitly discusses limits and baseline fairness. " +
          "The analysis contrasts pipeline constraints, observability tradeoffs, and deployment practicality, then closes with concrete ablation evidence that explains where gains come from and where they do not. " +
          "Finally, it summarizes implications for production IDS systems and future evaluation scope using reproducible criteria and bounded claims. "
        ).repeat(2);
        const candidate = buildTerminationCandidate("error", completeSummary);
        await maybeRecoverFromTermination(ctx, candidate, "proof");
      } finally {
        activePrompt = snapshot.activePrompt;
        agentRunning = snapshot.agentRunning;
        retryCount = snapshot.retryCount;
        recovering = snapshot.recovering;
        lastRetryAt = snapshot.lastRetryAt;
        latestUserPromptAt = snapshot.latestUserPromptAt;
      }

      notify(ctx, "Watchdog complete-termination proof executed.");
    },
  });

  pi.registerCommand("watchdog-proof-termination-ambiguous", {
    description: "Probe balanced termination ambiguity handling",
    handler: async (_args, ctx) => {
      const snapshot = {
        activePrompt,
        agentRunning,
        retryCount,
        recovering,
        lastRetryAt,
        latestUserPromptAt,
      };

      activePrompt = "[watchdog-proof-termination-ambiguous] synthetic prompt";
      agentRunning = true;
      recovering = false;
      retryCount = 0;
      lastRetryAt = 0;
      latestUserPromptAt = 0;

      try {
        const ambiguousSummary =
          "Sunago differs from prior systems by adaptive routing and a multi-stage design. The write-up lists plausible differentiators and baseline comparisons, but it does not yet close the argument with a clear synthesis across novelty, risk, and reproducibility dimensions.";
        const candidate = buildTerminationCandidate("error", ambiguousSummary);
        await maybeRecoverFromTermination(ctx, candidate, "proof");
      } finally {
        activePrompt = snapshot.activePrompt;
        agentRunning = snapshot.agentRunning;
        retryCount = snapshot.retryCount;
        recovering = snapshot.recovering;
        lastRetryAt = snapshot.lastRetryAt;
        latestUserPromptAt = snapshot.latestUserPromptAt;
      }

      notify(ctx, "Watchdog ambiguous-termination proof executed.");
    },
  });

  pi.registerCommand("watchdog-proof-termination-post-complete", {
    description: "Probe suppression when termination follows complete output",
    handler: async (_args, ctx) => {
      const snapshot = {
        activePrompt,
        agentRunning,
        retryCount,
        recovering,
        lastRetryAt,
        latestUserPromptAt,
      };

      activePrompt = "[watchdog-proof-termination-post-complete] synthetic prompt";
      agentRunning = true;
      recovering = false;
      retryCount = 0;
      lastRetryAt = 0;
      latestUserPromptAt = 0;

      try {
        const completeSummary = (
          "Sunago is novel because it jointly optimizes routing latency and classification quality while preserving interpretability through stage-wise decisions. " +
          "Compared to flat and offline-heavy baselines, this design provides real-time practicality and clearer operational trade-offs with bounded claims and measured effects. "
        ).repeat(5);
        const priorChars = normalizeSummary(completeSummary).length;
        const candidate = buildTerminationCandidate("error", "Error: terminated", priorChars, 1500, true);
        await maybeRecoverFromTermination(ctx, candidate, "proof");
      } finally {
        activePrompt = snapshot.activePrompt;
        agentRunning = snapshot.agentRunning;
        retryCount = snapshot.retryCount;
        recovering = snapshot.recovering;
        lastRetryAt = snapshot.lastRetryAt;
        latestUserPromptAt = snapshot.latestUserPromptAt;
      }

      notify(ctx, "Watchdog post-complete termination proof executed.");
    },
  });

  pi.registerCommand("watchdog-proof-termination-duplicate", {
    description: "Probe duplicate termination signature suppression",
    handler: async (_args, ctx) => {
      const snapshot = {
        activePrompt,
        agentRunning,
        retryCount,
        recovering,
        lastRetryAt,
        latestUserPromptAt,
        lastTerminationSignatureRetried,
      };

      activePrompt = "[watchdog-proof-termination-duplicate] synthetic prompt";
      agentRunning = true;
      recovering = false;
      retryCount = 0;
      lastRetryAt = 0;
      latestUserPromptAt = 0;
      lastTerminationSignatureRetried = "";

      try {
        const candidate = buildTerminationCandidate("aborted", "Error: terminated");
        await maybeRecoverFromTermination(ctx, candidate, "proof");
        await maybeRecoverFromTermination(ctx, candidate, "proof");
      } finally {
        activePrompt = snapshot.activePrompt;
        agentRunning = snapshot.agentRunning;
        retryCount = snapshot.retryCount;
        recovering = snapshot.recovering;
        lastRetryAt = snapshot.lastRetryAt;
        latestUserPromptAt = snapshot.latestUserPromptAt;
        lastTerminationSignatureRetried = snapshot.lastTerminationSignatureRetried;
      }

      notify(ctx, "Watchdog duplicate termination proof executed.");
    },
  });

  pi.registerCommand("watchdog-proof-termination-user-override", {
    description: "Probe suppression when newer user prompt exists",
    handler: async (_args, ctx) => {
      const snapshot = {
        activePrompt,
        agentRunning,
        retryCount,
        recovering,
        lastRetryAt,
        latestUserPromptAt,
      };

      activePrompt = "[watchdog-proof-termination-user-override] synthetic prompt";
      agentRunning = true;
      recovering = false;
      retryCount = 0;
      lastRetryAt = 0;

      try {
        const candidate = buildTerminationCandidate("error", "Error: terminated");
        latestUserPromptAt = Date.now() + 1000;
        await maybeRecoverFromTermination(ctx, candidate, "proof");
      } finally {
        activePrompt = snapshot.activePrompt;
        agentRunning = snapshot.agentRunning;
        retryCount = snapshot.retryCount;
        recovering = snapshot.recovering;
        lastRetryAt = snapshot.lastRetryAt;
        latestUserPromptAt = snapshot.latestUserPromptAt;
      }

      notify(ctx, "Watchdog user-override termination proof executed.");
    },
  });

  pi.registerCommand("watchdog-proof-write-schema-loop", {
    description: "Probe repeated invalid write tool-call suppression",
    handler: async (_args, ctx) => {
      const snapshot = {
        activePrompt,
        writeSchemaErrorCount,
        writeSchemaWindowStartedAt,
        lastWriteSchemaGuardAt,
      };

      activePrompt = "[watchdog-proof-write-schema-loop] synthetic prompt";
      writeSchemaErrorCount = 0;
      writeSchemaWindowStartedAt = 0;
      lastWriteSchemaGuardAt = 0;

      try {
        const err =
          "Validation failed for tool \"write\": must have required property 'path'; must have required property 'content'";
        handleWriteSchemaError(ctx, err, false);
        handleWriteSchemaError(ctx, err, false);
      } finally {
        activePrompt = snapshot.activePrompt;
        writeSchemaErrorCount = snapshot.writeSchemaErrorCount;
        writeSchemaWindowStartedAt = snapshot.writeSchemaWindowStartedAt;
        lastWriteSchemaGuardAt = snapshot.lastWriteSchemaGuardAt;
      }

      notify(ctx, "Watchdog write-schema proof executed.");
    },
  });

  pi.registerCommand("watchdog-proof-final-tail", {
    description: "Probe final-tail pending suppression of premature recovery",
    handler: async (_args, ctx) => {
      const snapshot = {
        activePrompt,
        agentRunning,
        retryCount,
        recovering,
        finalTailPending,
        finalTailStartedAt,
        finalTailFirstActivatedAt,
      };

      activePrompt = "[watchdog-proof-final-tail] synthetic prompt";
      agentRunning = true;
      recovering = false;
      retryCount = 0;
      finalTailPending = true;
      finalTailStartedAt = Date.now();
      finalTailFirstActivatedAt = Date.now();

      const retriesBefore = retryCount;
      let retriesAfter = retryCount;
      try {
        const candidate = buildTerminationCandidate("error", "Error: terminated");
        await maybeRecoverFromTermination(ctx, candidate, "turn_end");
        retriesAfter = retryCount;
      } finally {
        activePrompt = snapshot.activePrompt;
        agentRunning = snapshot.agentRunning;
        retryCount = snapshot.retryCount;
        recovering = snapshot.recovering;
        finalTailPending = snapshot.finalTailPending;
        finalTailStartedAt = snapshot.finalTailStartedAt;
        finalTailFirstActivatedAt = snapshot.finalTailFirstActivatedAt;
      }

      const suppressed = retriesBefore === retriesAfter;
      notify(
        ctx,
        `Watchdog final-tail proof: ${suppressed ? "recovery suppressed while final tail pending" : "unexpected retry"}.`,
        suppressed ? "info" : "warning"
      );
    },
  });

  pi.registerCommand("watchdog", {
    description: "Watchdog status and recent recovery diagnostics",
    handler: async (args, ctx) => {
      const mode = args.trim().toLowerCase() || "status";
      const nowMs = Date.now();
      const events = readRecentWatchdogEvents(config.traceFile, 600);
      const stats = analyzeWatchdogEvents(events, nowMs, WATCHDOG_COMMAND_WINDOW_MS);
      const verifierModel = resolveVerifierModel(ctx)?.id || config.verifierModel || resolvePrimaryModelId(ctx) || "unknown";

      const summaryLines = [
        `watchdog active=${agentRunning ? "yes" : "no"} turn=${turnRunning ? "running" : "idle"} tool=${toolRunning ? "running" : "idle"}`,
        `retries=${retryCount}/${config.maxRetries} finalTail=${finalTailPending ? "pending" : "clear"} verifier=${verifierInFlight ? "running" : "idle"}`,
        `verifierModel=${verifierModel} recoverOnTermination=${config.recoverOnTermination ? "on" : "off"}`,
        `recent(${Math.round(WATCHDOG_COMMAND_WINDOW_MS / 60000)}m) pseudo=${stats.pseudoToolCalls.recent} semantic=${stats.semanticToolFailures.recent} retries=${stats.retries.recent} recoveries=${stats.recoveries.recent} suppressions=${stats.suppressions.recent}`,
      ];

      const recentLines = stats.recentEvents.length > 0
        ? ["recent:", ...stats.recentEvents.map((line) => `- ${line}`)]
        : ["recent: none"];

      const verifyLines = [
        `verifier model=${verifierModel}`,
        `verifyBeforeRetry=${config.verifyBeforeRetry ? "on" : "off"}`,
        `terminationVerifyAmbiguous=${config.terminationVerifyAmbiguous ? "on" : "off"}`,
        `verifierInactivityMs=${config.verifierInactivityMs}`,
        `recent verifierErrors=${stats.verifierErrors.recent} total=${stats.verifierErrors.total}`,
      ];

      let lines: string[];
      if (mode === "status") {
        lines = [...summaryLines, ...recentLines];
      } else if (mode === "recent") {
        lines = recentLines;
      } else if (mode === "verify") {
        lines = verifyLines;
      } else if (mode === "help") {
        lines = [
          "Usage: /watchdog [status|recent|verify|help]",
          "- status: current watchdog state + recent recovery counters",
          "- recent: recent watchdog recovery/suppression events",
          "- verify: verifier model and retry-gate settings",
        ];
      } else {
        lines = ["Usage: /watchdog [status|recent|verify|help]"];
      }

      const level: "info" | "warning" = stats.pseudoToolCalls.recent > 0 || stats.semanticToolFailures.recent > 0 ? "warning" : "info";
      notify(ctx, lines.join("\n"), level);
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const prompt = typeof event?.prompt === "string" ? event.prompt.trim() : "";
    if (!prompt) {
      touch();
      return;
    }

    const isSynthetic =
      prompt.startsWith(RETRY_PREFIX) || prompt.startsWith(CRON_PREFIX) || prompt.startsWith(TOOL_GUARD_PREFIX);
    if (!isSynthetic) {
      activePrompt = prompt;
      retryCount = 0;
      pendingTermination = null;
      lastTerminationSignatureRetried = "";
      latestUserPromptAt = Date.now();
      lastStableAssistantSummary = "";
      lastStableAssistantAt = 0;
      writeSchemaErrorCount = 0;
      writeSchemaWindowStartedAt = 0;
     finalTailPending = false;
    finalTailStartedAt = 0;
    finalTailFirstActivatedAt = 0;
    queuedWriteSchemaGuard = false;
    queuedWriteSchemaErrorText = "";

      clearFinalTailTimer();
      setWatchdogStatus(ctx);
    }

    touch();
  });

  pi.on("agent_start", async (_event, ctx) => {
    agentRunning = true;
    turnRunning = false;
    toolRunning = false;
    turnStartedAt = 0;
    turnStartContextTokens = 0;
    assistantMessageStartedAt = 0;
    lastToolProgressAt = 0;
    verifierInFlight = false;
    pendingTermination = null;
    lastAssistantSummaryInTurn = "";
    lastAssistantSummaryAt = 0;
    lastStableAssistantSummary = "";
    lastStableAssistantAt = 0;
    writeSchemaErrorCount = 0;
    writeSchemaWindowStartedAt = 0;
    finalTailPending = false;
    finalTailStartedAt = 0;
    finalTailFirstActivatedAt = 0;
    queuedWriteSchemaGuard = false;
    queuedWriteSchemaErrorText = "";
    clearFinalTailTimer();
    touch();
    startWatchdog(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (pendingTermination && !finalTailPending) {
      const candidate = pendingTermination;
      pendingTermination = null;
      await maybeRecoverFromTermination(ctx, candidate, "agent_end");
    } else if (pendingTermination && finalTailPending) {
      trace("termination_recovery_deferred", { source: "agent_end", reason: "final_tail_pending" });
    }

    agentRunning = false;
    turnRunning = false;
    toolRunning = false;
    turnStartedAt = 0;
    turnStartContextTokens = 0;
    assistantMessageStartedAt = 0;
    lastToolProgressAt = 0;
    verifierInFlight = false;
    lastAssistantSummaryInTurn = "";
    lastAssistantSummaryAt = 0;
    if (!finalTailPending) {
      pendingTermination = null;
      lastStableAssistantSummary = "";
      lastStableAssistantAt = 0;
      queuedWriteSchemaGuard = false;
      queuedWriteSchemaErrorText = "";
      clearFinalTailTimer();
    }
    touch();
    clearWatchdog();
  });

  pi.on("turn_start", async (_event, ctx) => {
    turnRunning = true;
    toolRunning = false;
    turnStartedAt = Date.now();
    assistantMessageStartedAt = 0;
    lastAssistantSummaryInTurn = "";
    lastAssistantSummaryAt = 0;
    turnStartContextTokens = ctx.getContextUsage()?.tokens ?? 0;
    touch();
  });

  pi.on("turn_end", async (event, ctx) => {
    const turnStopReason = event?.message?.stopReason;
    if (turnStopReason === "stop") {
      resolveFinalTail("turn_end_stop");
      queuedWriteSchemaGuard = false;
      queuedWriteSchemaErrorText = "";
    }

    if (pendingTermination && !finalTailPending) {
      const candidate = pendingTermination;
      pendingTermination = null;
      await maybeRecoverFromTermination(ctx, candidate, "turn_end");
    } else if (pendingTermination && finalTailPending) {
      trace("termination_recovery_deferred", { source: "turn_end", reason: "final_tail_pending" });
    }

    turnRunning = false;
    toolRunning = false;
    turnStartedAt = 0;
    turnStartContextTokens = 0;
    assistantMessageStartedAt = 0;
    lastToolProgressAt = 0;
    lastAssistantSummaryInTurn = "";
    lastAssistantSummaryAt = 0;
    touch();
  });

  pi.on("tool_execution_start", async () => {
    toolRunning = true;
    lastToolProgressAt = Date.now();
    touch();
  });

  pi.on("tool_execution_update", async () => {
    lastToolProgressAt = Date.now();
    touch();
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    toolRunning = false;
    lastToolProgressAt = Date.now();

    const toolName = typeof event?.toolName === "string" ? event.toolName : "";
    const errorText = extractToolErrorText(event);
    if (event?.isError && toolName === "write" && isWriteSchemaValidationError(errorText)) {
      handleWriteSchemaError(ctx, errorText, true);
    }

    const toolSummary = summarizeToolResult(event?.result);
    if (
      !event?.isError &&
      toolName === "bash" &&
      isSemanticToolFailureText(`${errorText}\n${toolSummary}`) &&
      activePrompt.trim()
    ) {
      const candidate = buildTerminationCandidate(
        "error",
        truncate(normalizeSummary(toolSummary || errorText), 700),
        lastAssistantSummaryInTurn.length,
        lastAssistantSummaryAt > 0 ? Date.now() - lastAssistantSummaryAt : -1,
        isLikelyClosedResponse(lastAssistantSummaryInTurn),
        {
          kind: "semantic_tool_failure",
          metadata: {
            toolName,
            errorText: truncate(errorText, 220),
          },
        }
      );
      pendingTermination = candidate;
      trace("semantic_tool_failure_detected", {
        toolName,
        summary: candidate.summary,
        stopReason: candidate.stopReason,
      });
    }

    touch();
  });

  pi.on("message_start", async (event) => {
    if (event?.message?.role === "assistant") {
      assistantMessageStartedAt = Date.now();
      touch();
    }
  });

  pi.on("message_update", async () => {
    touch();
  });

  pi.on("message_end", async (event, ctx) => {
    const message = event?.message;
    const role = message?.role;
    if (role === "assistant") {
      const summary = extractText(message?.content || "");
      const stopReason = message?.stopReason;
      if (stopReason === "toolUse") {
        startFinalTailWatch(ctx, "assistant_tool_use");
      } else if (stopReason === "stop") {
        resolveFinalTail("assistant_stop");
        queuedWriteSchemaGuard = false;
        queuedWriteSchemaErrorText = "";
      }

      if (isTerminationLike(stopReason, summary)) {
        const now = Date.now();
        const inTurnPriorChars = lastAssistantSummaryInTurn.length;
        const inTurnPriorAgeMs = lastAssistantSummaryAt > 0 ? now - lastAssistantSummaryAt : -1;
        const globalPriorChars = lastStableAssistantSummary.length;
        const globalPriorAgeMs = lastStableAssistantAt > 0 ? now - lastStableAssistantAt : -1;
        const priorSummary = inTurnPriorChars > 0 ? lastAssistantSummaryInTurn : lastStableAssistantSummary;
        const priorChars = inTurnPriorChars > 0 ? inTurnPriorChars : globalPriorChars;
        const priorAgeMs = inTurnPriorChars > 0 ? inTurnPriorAgeMs : globalPriorAgeMs;
        const priorClosed = isLikelyClosedResponse(priorSummary);
        const candidate = buildTerminationCandidate(stopReason, summary, priorChars, priorAgeMs, priorClosed);
        pendingTermination = candidate;
        trace("termination_signal_detected", {
          stopReason,
          summary: summary.replace(/\s+/g, " ").trim().slice(0, 220),
          assistantChars: candidate.assistantChars,
          priorAssistantChars: candidate.priorAssistantChars,
          priorAssistantAgeMs: candidate.priorAssistantAgeMs,
          priorAssistantClosed: candidate.priorAssistantClosed,
          signature: candidate.signature,
        });
        trace("termination_candidate_detected", {
          stopReason: candidate.stopReason,
          assistantChars: candidate.assistantChars,
          priorAssistantChars: candidate.priorAssistantChars,
          priorAssistantAgeMs: candidate.priorAssistantAgeMs,
          priorAssistantClosed: candidate.priorAssistantClosed,
          signature: candidate.signature,
        });
      } else if (stopReason === "stop" && containsPseudoToolCallText(summary)) {
        const now = Date.now();
        const inTurnPriorChars = lastAssistantSummaryInTurn.length;
        const inTurnPriorAgeMs = lastAssistantSummaryAt > 0 ? now - lastAssistantSummaryAt : -1;
        const priorSummary = inTurnPriorChars > 0 ? lastAssistantSummaryInTurn : lastStableAssistantSummary;
        const priorChars = inTurnPriorChars > 0 ? inTurnPriorChars : lastStableAssistantSummary.length;
        const priorAgeMs = inTurnPriorChars > 0 ? inTurnPriorAgeMs : (lastStableAssistantAt > 0 ? now - lastStableAssistantAt : -1);
        const priorClosed = isLikelyClosedResponse(priorSummary);
        const candidate = buildTerminationCandidate("error", summary, priorChars, priorAgeMs, priorClosed, {
          kind: "pseudo_tool_call",
          metadata: { originalStopReason: stopReason },
        });
        pendingTermination = candidate;
        trace("pseudo_tool_call_detected", {
          assistantChars: candidate.assistantChars,
          priorAssistantChars: candidate.priorAssistantChars,
          signature: candidate.signature,
        });
      } else {
        const normalized = normalizeSummary(summary);
        lastAssistantSummaryInTurn = normalized;
        lastAssistantSummaryAt = Date.now();
        lastStableAssistantSummary = normalized;
        lastStableAssistantAt = lastAssistantSummaryAt;
        if (stopReason === "stop") {
          pendingTermination = null;
        }
      }
    } else if (role === "user") {
      latestUserPromptAt = Date.now();
      pendingTermination = null;
      resolveFinalTail("new_user_message");
      queuedWriteSchemaGuard = false;
      queuedWriteSchemaErrorText = "";
    }
    touch();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    agentRunning = false;
    turnRunning = false;
    toolRunning = false;
    turnStartedAt = 0;
    turnStartContextTokens = 0;
    assistantMessageStartedAt = 0;
    lastToolProgressAt = 0;
    verifierInFlight = false;
    pendingTermination = null;
    lastTerminationSignatureRetried = "";
    latestUserPromptAt = 0;
    lastAssistantSummaryInTurn = "";
    lastAssistantSummaryAt = 0;
    lastStableAssistantSummary = "";
    lastStableAssistantAt = 0;
    writeSchemaErrorCount = 0;
    writeSchemaWindowStartedAt = 0;
    lastWriteSchemaGuardAt = 0;
    finalTailPending = false;
    finalTailStartedAt = 0;
    finalTailFirstActivatedAt = 0;
    queuedWriteSchemaGuard = false;
    queuedWriteSchemaErrorText = "";
    clearFinalTailTimer();
    if (ctx?.hasUI) ctx.ui.setStatus("watchdog", undefined);
    clearWatchdog();
    clearCronTimers();
  });
}
