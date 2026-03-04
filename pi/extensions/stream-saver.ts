import fs from "node:fs";
import { homedir } from "node:os";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const TRACE_FILE = process.env.PI_STREAM_SAVER_TRACE_FILE || `${homedir()}/.pi/agent/stream-saver.jsonl`;
const TRACE_ENABLED = parseBoolean(process.env.PI_STREAM_SAVER_TRACE_ENABLED, true);
const MAX_BUFFER_CHARS = parsePositiveInt(process.env.PI_STREAM_SAVER_MAX_BUFFER_CHARS, 50_000);
const MIN_RECOVERY_CHARS = parsePositiveInt(process.env.PI_STREAM_SAVER_MIN_RECOVERY_CHARS, 20);
const CUSTOM_TYPE = "stream-recovery";

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

function trace(type: string, payload: Record<string, unknown> = {}): void {
  if (!TRACE_ENABLED) return;
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), type, ...payload });
    fs.appendFileSync(TRACE_FILE, `${line}\n`, "utf-8");
  } catch {
    // Ignore trace write failures.
  }
}

/**
 * Extract text from AssistantMessageEvent streaming deltas.
 *
 * The `message_update` event provides `assistantMessageEvent` which contains
 * the proxy event with streaming delta types: text_delta, thinking_delta, etc.
 * We capture text_delta content for recovery purposes.
 *
 * AssistantMessageEvent shape (from @mariozechner/pi-ai):
 *   { type: "text_delta", contentIndex: number, delta: string, partial: AssistantMessage }
 *   { type: "thinking_delta", contentIndex: number, delta: string, partial: AssistantMessage }
 */
function extractDeltaText(assistantMessageEvent: any): string {
  if (!assistantMessageEvent || typeof assistantMessageEvent !== "object") return "";

  if (assistantMessageEvent.type === "text_delta" && typeof assistantMessageEvent.delta === "string") {
    return assistantMessageEvent.delta;
  }

  // Also capture thinking_delta for completeness (useful for extended thinking models).
  if (assistantMessageEvent.type === "thinking_delta" && typeof assistantMessageEvent.delta === "string") {
    return assistantMessageEvent.delta;
  }

  return "";
}

/**
 * Extract committed text from a message's content array for comparison.
 */
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

export default function streamSaverExtension(pi: ExtensionAPI): void {
  let assistantStreaming = false;
  let streamBuffer = "";
  let updateCount = 0;
  let streamStartedAt = 0;

  function resetBuffer(): void {
    assistantStreaming = false;
    streamBuffer = "";
    updateCount = 0;
    streamStartedAt = 0;
  }

  function appendToBuffer(text: string): void {
    if (!text) return;
    const remaining = MAX_BUFFER_CHARS - streamBuffer.length;
    if (remaining <= 0) return;
    streamBuffer += text.length <= remaining ? text : text.slice(0, remaining);
  }

  /**
   * Persist the buffered streamed content as a custom message so it survives
   * the TUI's removal of the streaming component on abnormal agent_end.
   */
  function persistRecoveredOutput(ctx: ExtensionContext): void {
    const content = streamBuffer.trim();
    if (content.length < MIN_RECOVERY_CHARS) {
      trace("recovery_skipped", {
        reason: "below_min_chars",
        bufferedChars: content.length,
        minRequired: MIN_RECOVERY_CHARS,
      });
      return;
    }

    const durationMs = streamStartedAt > 0 ? Date.now() - streamStartedAt : -1;

    trace("recovery_persisted", {
      bufferedChars: content.length,
      updateCount,
      durationMs,
    });

    try {
      pi.sendMessage(
        {
          customType: CUSTOM_TYPE,
          content: `--- Recovered partial output (run aborted) ---\n\n${content}`,
          display: true,
          details: {
            recoveredChars: content.length,
            streamUpdates: updateCount,
            streamDurationMs: durationMs,
          },
        },
        { triggerTurn: false }
      );
    } catch (error) {
      trace("recovery_send_error", {
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  // --- Event Handlers ---

  pi.on("session_start", async (_event, ctx) => {
    resetBuffer();
    trace("session_start", {
      maxBufferChars: MAX_BUFFER_CHARS,
      minRecoveryChars: MIN_RECOVERY_CHARS,
      traceFile: TRACE_FILE,
    });
    if (ctx.hasUI) {
      ctx.ui.setStatus("stream-saver", "stream-saver:on");
    }
  });

  pi.on("message_start", async (event) => {
    if (event?.message?.role === "assistant") {
      // New assistant message stream starting -- reset and begin capturing.
      resetBuffer();
      assistantStreaming = true;
      streamStartedAt = Date.now();
      trace("assistant_stream_start");
    }
  });

  pi.on("message_update", async (event) => {
    if (!assistantStreaming) return;

    updateCount += 1;
    const deltaText = extractDeltaText(event?.assistantMessageEvent);
    if (deltaText) {
      appendToBuffer(deltaText);
    }

    // Sample trace logging every 50 updates to avoid log bloat.
    if (updateCount % 50 === 0) {
      trace("stream_progress", {
        updateCount,
        bufferedChars: streamBuffer.length,
        elapsedMs: streamStartedAt > 0 ? Date.now() - streamStartedAt : -1,
      });
    }
  });

  pi.on("message_end", async (event) => {
    if (event?.message?.role !== "assistant") return;

    // The assistant message was properly committed by the TUI.
    // No recovery needed -- clear the buffer.
    const stopReason = event?.message?.stopReason;
    trace("assistant_stream_end", {
      stopReason,
      bufferedChars: streamBuffer.length,
      updateCount,
      committed: true,
    });
    resetBuffer();
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!assistantStreaming) {
      // No active stream at agent_end -- nothing to recover.
      trace("agent_end_no_active_stream");
      resetBuffer();
      return;
    }

    // The agent ended while an assistant message was still streaming
    // (no message_end was received). This is the bug condition.
    // Persist the buffered content as a custom message.
    const messageCount = Array.isArray(event?.messages) ? event.messages.length : 0;
    trace("agent_end_active_stream", {
      bufferedChars: streamBuffer.length,
      updateCount,
      messageCount,
      elapsedMs: streamStartedAt > 0 ? Date.now() - streamStartedAt : -1,
    });

    persistRecoveredOutput(ctx);
    resetBuffer();
  });

  // --- Custom Message Renderer ---

  pi.registerMessageRenderer(CUSTOM_TYPE, {
    render(message: any) {
      const content = typeof message?.content === "string" ? message.content : "";
      const details = message?.details || {};
      const chars = typeof details.recoveredChars === "number" ? details.recoveredChars : "?";
      const updates = typeof details.streamUpdates === "number" ? details.streamUpdates : "?";

      return {
        header: `Stream Recovery (${chars} chars, ${updates} updates)`,
        body: content,
      };
    },
  });

  // --- Commands ---

  pi.registerCommand("stream-saver-status", {
    description: "Show stream-saver extension status",
    handler: async (_args, ctx) => {
      const status = [
        `stream-saver: ${assistantStreaming ? "capturing" : "idle"}`,
        `buffer: ${streamBuffer.length}/${MAX_BUFFER_CHARS} chars`,
        `updates: ${updateCount}`,
        `trace: ${TRACE_ENABLED ? TRACE_FILE : "off"}`,
      ].join(" | ");

      if (ctx.hasUI) ctx.ui.notify(status);
      trace("status_query", {
        streaming: assistantStreaming,
        bufferedChars: streamBuffer.length,
        updateCount,
      });
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    resetBuffer();
    if (ctx?.hasUI) ctx.ui.setStatus("stream-saver", undefined);
    trace("session_shutdown");
  });
}
