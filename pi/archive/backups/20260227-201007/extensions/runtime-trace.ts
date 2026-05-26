import fs from "node:fs";
import { homedir } from "node:os";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const TRACE_FILE = process.env.PI_RUNTIME_TRACE_FILE || `${homedir()}/.pi/agent/runtime-trace.jsonl`;
const TRACE_ENABLED = parseBoolean(process.env.PI_RUNTIME_TRACE_ENABLED, true);
const MAX_TEXT = parsePositiveInt(process.env.PI_RUNTIME_TRACE_MAX_TEXT, 320);

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

export default function runtimeTraceExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    writeTrace("session_start", {
      cwd: process.cwd(),
      traceFile: TRACE_FILE,
      model: ctx.model?.id,
      provider: ctx.provider?.name,
    });
  });

  pi.registerCommand("trace-status", {
    description: "Show runtime trace status",
    handler: async (_args, ctx) => {
      let size = 0;
      try {
        if (fs.existsSync(TRACE_FILE)) {
          size = fs.statSync(TRACE_FILE).size;
        }
      } catch {
        // Ignore fs errors.
      }

      const msg = `trace enabled=${TRACE_ENABLED ? "yes" : "no"} file=${TRACE_FILE} size=${size}B`;
      if (ctx.hasUI) ctx.ui.notify(msg);
      writeTrace("trace_status", { size });
    },
  });

  pi.registerCommand("trace-clear", {
    description: "Clear runtime trace file",
    handler: async (_args, ctx) => {
      try {
        fs.writeFileSync(TRACE_FILE, "", "utf-8");
        if (ctx.hasUI) ctx.ui.notify(`trace cleared: ${TRACE_FILE}`);
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(`trace clear failed: ${String(error)}`, "error");
      }
      writeTrace("trace_cleared");
    },
  });

  pi.registerCommand("trace-mark", {
    description: "Write a custom marker to trace",
    handler: async (args, ctx) => {
      const label = args.trim() || "manual-mark";
      writeTrace("mark", { label });
      if (ctx.hasUI) ctx.ui.notify(`trace mark: ${label}`);
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

  pi.on("session_shutdown", async () => {
    writeTrace("session_shutdown");
  });
}
