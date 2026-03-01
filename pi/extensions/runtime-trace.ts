import fs from "node:fs";
import { homedir } from "node:os";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const TRACE_FILE = process.env.PI_RUNTIME_TRACE_FILE || `${homedir()}/.pi/agent/runtime-trace.jsonl`;
const TRACE_ENABLED = parseBoolean(process.env.PI_RUNTIME_TRACE_ENABLED, true);
const MAX_TEXT = parsePositiveInt(process.env.PI_RUNTIME_TRACE_MAX_TEXT, 320);
const PRIMARY_MODEL = process.env.PI_PRIMARY_MODEL || "unsloth/qwen3.5-35b-a3b";
const LMSTUDIO_MODELS_URL = process.env.PI_LMSTUDIO_MODELS_URL || "http://localhost:1234/api/v0/models";
const LMSTUDIO_MODELS_TIMEOUT_MS = parsePositiveInt(process.env.PI_LMSTUDIO_MODELS_TIMEOUT_MS, 2500);
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

  return [
    { name: "runtime", path: TRACE_FILE, enabled: TRACE_ENABLED },
    { name: "compaction", path: compactionTraceFile, enabled: true },
    { name: "watchdog", path: watchdogTraceFile, enabled: true },
    { name: "hybrid", path: hybridTraceFile, enabled: true },
    { name: "research", path: researchTraceFile, enabled: true },
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

async function fetchLoadedModelInfo(modelId: string): Promise<{ loadedContextLength: number | null; state: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LMSTUDIO_MODELS_TIMEOUT_MS);
  try {
    const response = await fetch(LMSTUDIO_MODELS_URL, { signal: controller.signal });
    if (!response.ok) return { loadedContextLength: null, state: "unavailable" };
    const data = (await response.json()) as any;
    const rows = Array.isArray(data?.data) ? data.data : [];
    const row = rows.find((entry: any) => entry && typeof entry.id === "string" && entry.id === modelId);
    if (!row) return { loadedContextLength: null, state: "not-found" };
    const loaded = Number(row.loaded_context_length);
    const loadedContextLength = Number.isFinite(loaded) && loaded > 0 ? Math.floor(loaded) : null;
    return { loadedContextLength, state: String(row.state || "unknown") };
  } catch {
    return { loadedContextLength: null, state: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

export default function runtimeTraceExtension(pi: ExtensionAPI): void {
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

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("runtime-trace", `trace:${TRACE_ENABLED ? "on" : "off"}`);
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
    description: "Unified health diagnostics for custom extensions",
    handler: async (_args, ctx) => {
      const targets = getTraceTargets();
      const status = buildTraceStatusSummary(targets);
      const nowMs = Date.now();
      const signals = analyzeRuntimeSignals(readRecentTraceEvents(TRACE_FILE, 900), nowMs, DOCTOR_SIGNAL_WINDOW_MS);
      const configuredContext = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : null;
      const loaded = await fetchLoadedModelInfo(ctx.model?.id || PRIMARY_MODEL);
      const modelCheck = Boolean(ctx.modelRegistry.find("lmstudio", PRIMARY_MODEL));

      const lines = [
        `doctor model=${ctx.model?.id || "unknown"}`,
        `primary=${PRIMARY_MODEL} registry=${modelCheck ? "ok" : "missing"}`,
        `lmstudio state=${loaded.state} loadedContext=${loaded.loadedContextLength ?? "unknown"} configuredContext=${configuredContext ?? "unknown"}`,
        `signals recent(${Math.round(DOCTOR_SIGNAL_WINDOW_MS / 60000)}m) lengthStops=${signals.recent.lengthStops} writeSchemaErrors=${signals.recent.writeSchemaErrors} terminations=${signals.recent.terminations}`,
        `signals total lengthStops=${signals.total.lengthStops} writeSchemaErrors=${signals.total.writeSchemaErrors} terminations=${signals.total.terminations}`,
        status.message,
      ];

      if (
        configuredContext &&
        loaded.loadedContextLength &&
        loaded.loadedContextLength > 0 &&
        loaded.loadedContextLength < configuredContext
      ) {
        lines.push(
          `warning context mismatch configured=${configuredContext.toLocaleString()} loaded=${loaded.loadedContextLength.toLocaleString()}`
        );
      }

      const hasActiveSignalIssues = signals.recent.writeSchemaErrors >= 2 || signals.recent.lengthStops >= 3;
      const hasContextMismatch =
        Boolean(configuredContext) &&
        Boolean(loaded.loadedContextLength) &&
        Number(loaded.loadedContextLength) > 0 &&
        Number(loaded.loadedContextLength) < Number(configuredContext);
      const level: "info" | "warning" = hasActiveSignalIssues || hasContextMismatch ? "warning" : "info";

      if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), level);
      writeTrace("doctor", {
        model: ctx.model?.id,
        primaryModel: PRIMARY_MODEL,
        registryHasPrimary: modelCheck,
        configuredContext,
        loadedContext: loaded.loadedContextLength,
        loadedState: loaded.state,
        signalWindowMs: DOCTOR_SIGNAL_WINDOW_MS,
        signals,
        traces: status.sizes,
      });
    },
  });

  pi.on("agent_start", async (_event, ctx) => {
    writeTrace("agent_start", { model: ctx.model?.id, provider: ctx.provider?.name });
  });

  pi.on("agent_end", async (event) => {
    writeTrace("agent_end", { messages: Array.isArray(event?.messages) ? event.messages.length : 0 });
  });

  pi.on("turn_start", async (event) => {
    writeTrace("turn_start", { turnIndex: event?.turnIndex });
  });

  pi.on("turn_end", async (event) => {
    const stopReason = event?.message?.stopReason;
    const toolResults = Array.isArray(event?.toolResults) ? event.toolResults.length : 0;
    const usage = event?.message?.usage?.totalTokens ?? null;
    writeTrace("turn_end", { turnIndex: event?.turnIndex, stopReason, toolResults, totalTokens: usage });
  });

  pi.on("message_end", async (event, ctx) => {
    const message = event?.message;
    const role = message?.role || "unknown";
    const summary = summarizeMessage(message);
    const stopReason = message?.stopReason;
    writeTrace("message_end", { role, stopReason, summary });

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
    if (ctx?.hasUI) ctx.ui.setStatus("runtime-trace", undefined);
    writeTrace("session_shutdown");
  });
}
