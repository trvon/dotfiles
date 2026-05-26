import fs from "node:fs";
import { homedir } from "node:os";

import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

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
  verifierTimeoutMs: number;
  traceFile: string;
};

const RETRY_PREFIX = "[health-watchdog:auto-retry]";
const CRON_PREFIX = "[health-watchdog:cron]";
const VERIFIER_UI_PROGRESS_NOTIFY_MS = parsePositiveInt(
  process.env.PI_HEALTH_WATCHDOG_UI_PROGRESS_NOTIFY_MS,
  1500
);

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
  verifierProvider: "lmstudio",
  verifierModel: "mistralai/ministral-3-14b-reasoning",
  verifierMaxTokens: 120,
  verifierTimeoutMs: 5_000,
  traceFile: "",
};

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
    verifierTimeoutMs: parsePositiveInt(
      process.env.PI_HEALTH_WATCHDOG_VERIFIER_TIMEOUT_MS,
      DEFAULT_CONFIG.verifierTimeoutMs
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

  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  const cronTimers: Array<ReturnType<typeof setInterval>> = [];

  const cronQueued = new Set<string>();

  function notify(ctx: any, message: string, type: "info" | "warning" | "error" = "info"): void {
    if (!config.notify) return;
    if (!ctx?.hasUI) return;
    ctx.ui.notify(message, type);
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

  function resolveVerifierModel(ctx: ExtensionContext): any {
    return (
      ctx.modelRegistry.find(config.verifierProvider, config.verifierModel) ||
      ctx.modelRegistry.find(config.verifierProvider, "mistralai/ministral-3-14b-reasoning") ||
      ctx.modelRegistry.find(config.verifierProvider, "unsloth/qwen3.5-27b") ||
      ctx.modelRegistry.find(config.verifierProvider, "qwen/qwen3.5-35b-a3b") ||
      null
    );
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
      const response = await withTimeout(
        complete(
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
          { apiKey, maxTokens: config.verifierMaxTokens }
        ),
        config.verifierTimeoutMs
      );

      const text = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
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
      const shouldRetry = await shouldRetryModelStall(ctx, turnElapsedMs, effectiveModelStallMs);
      if (!shouldRetry) {
        touch();
        return;
      }
    }

    if (retryCount >= config.maxRetries) {
      notify(ctx, `Health watchdog: max retries reached for prompt.`, "warning");
      clearWatchdog();
      return;
    }

    retryCount += 1;
    lastRetryAt = Date.now();
    recovering = true;
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
    touch();
    retryCount = 0;
    verifierUnavailableNotified = false;
    trace("session_start", {
      verifyBeforeRetry: config.verifyBeforeRetry,
      verifierModel: config.verifierModel,
      toolStallAfterMs: config.toolStallAfterMs,
      modelStallAfterMs: config.modelStallAfterMs,
    });
    scheduleCronJobs(ctx);
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

  pi.on("before_agent_start", async (event, _ctx) => {
    const prompt = typeof event?.prompt === "string" ? event.prompt.trim() : "";
    if (!prompt) {
      touch();
      return;
    }

    const isSynthetic = prompt.startsWith(RETRY_PREFIX) || prompt.startsWith(CRON_PREFIX);
    if (!isSynthetic) {
      activePrompt = prompt;
      retryCount = 0;
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
    touch();
    startWatchdog(ctx);
  });

  pi.on("agent_end", async (_event, _ctx) => {
    agentRunning = false;
    turnRunning = false;
    toolRunning = false;
    turnStartedAt = 0;
    turnStartContextTokens = 0;
    assistantMessageStartedAt = 0;
    lastToolProgressAt = 0;
    touch();
    clearWatchdog();
  });

  pi.on("turn_start", async (_event, ctx) => {
    turnRunning = true;
    toolRunning = false;
    turnStartedAt = Date.now();
    assistantMessageStartedAt = 0;
    turnStartContextTokens = ctx.getContextUsage()?.tokens ?? 0;
    touch();
  });

  pi.on("turn_end", async () => {
    turnRunning = false;
    toolRunning = false;
    turnStartedAt = 0;
    turnStartContextTokens = 0;
    assistantMessageStartedAt = 0;
    lastToolProgressAt = 0;
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

  pi.on("tool_execution_end", async () => {
    toolRunning = false;
    lastToolProgressAt = Date.now();
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

  pi.on("message_end", async () => {
    touch();
  });

  pi.on("session_shutdown", async () => {
    agentRunning = false;
    turnRunning = false;
    toolRunning = false;
    turnStartedAt = 0;
    turnStartContextTokens = 0;
    assistantMessageStartedAt = 0;
    lastToolProgressAt = 0;
    clearWatchdog();
    clearCronTimers();
  });
}
