import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";

import { stream } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getSidecarConfig, resolveActiveProvider, resolveSidecarProvider } from "./model-backend.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TRACE_FILE = process.env.PI_COMPACTION_GUARD_TRACE_FILE || `${homedir()}/.pi/agent/compaction-guard.jsonl`;
const TRACE_ENABLED = parseBoolean(process.env.PI_COMPACTION_GUARD_TRACE_ENABLED, true);
const FORCE_SIMPLE_UNDER_TOKENS = parsePositiveInt(process.env.PI_COMPACTION_GUARD_FORCE_SIMPLE_UNDER_TOKENS, 512);

// 9b summarization configuration
const ENV_COMPACTION_MODEL = (process.env.PI_COMPACTION_MODEL || "").trim();
const ENV_COMPACTION_PROVIDER = (process.env.PI_COMPACTION_PROVIDER || "").trim();
const COMPACTION_INACTIVITY_MS = parsePositiveInt(process.env.PI_COMPACTION_INACTIVITY_MS, 30000);
const COMPACTION_MAX_INPUT_CHARS = parsePositiveInt(process.env.PI_COMPACTION_MAX_INPUT_CHARS, 24000);
const COMPACTION_MAX_TOKENS = parsePositiveInt(process.env.PI_COMPACTION_MAX_TOKENS, 4096);

// DCS-powered compaction (opt-in)
const DCS_COMPACTION_ENABLED = parseBoolean(process.env.PI_COMPACTION_DCS_ENABLED, false);
const DCS_COMPACTION_TIMEOUT_MS = parsePositiveInt(process.env.PI_COMPACTION_DCS_TIMEOUT_MS, 120_000);
const DCS_CLI = process.env.PI_COMPACTION_DCS_CLI || "research-agent";
const DCS_CONTEXT_PROFILE = process.env.PI_COMPACTION_DCS_CONTEXT_PROFILE || "small";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

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
  const out: string[] = [];
  for (const c of content) {
    if (typeof c === "string") {
      out.push(c);
      continue;
    }
    if (!c || typeof c !== "object") continue;
    if (typeof c.text === "string") out.push(c.text);
    if (typeof c.content === "string") out.push(c.content);
  }
  return out.join("\n");
}

/**
 * Convert branchEntries (SessionEntry[]) to the message format used by
 * serializeMessages().  Mirrors Pi's internal getMessageFromEntry():
 *  - "message" entries -> entry.message (has { role, content })
 *  - "custom_message" / "branch_summary" entries are treated as user-role
 *  - Other types (compaction, label, model_change, etc.) are skipped.
 */
function getMessagesFromBranchEntries(entries: any[]): any[] {
  const msgs: any[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "message" && entry.message) {
      msgs.push(entry.message);
    } else if (entry.type === "custom_message" && entry.content) {
      msgs.push({
        role: "user",
        content: typeof entry.content === "string"
          ? [{ type: "text", text: entry.content }]
          : entry.content,
      });
    } else if (entry.type === "branch_summary" && entry.summary) {
      msgs.push({
        role: "user",
        content: [{ type: "text", text: `[branch summary]: ${entry.summary}` }],
      });
    }
    // compaction, label, thinking_level_change, model_change -> skip
  }
  return msgs;
}

function trace(type: string, payload: Record<string, unknown> = {}): void {
  if (!TRACE_ENABLED) return;
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), type, ...payload });
    fs.appendFileSync(TRACE_FILE, `${line}\n`, "utf-8");
  } catch {
    // Ignore trace write errors.
  }
}

/**
 * Stream a completion and abort only if no new events arrive within `inactivityMs`.
 * As long as LM Studio is actively generating tokens, the timer resets and the
 * request is never killed.  Falls back to abort+error only when the connection
 * goes truly idle.
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

  // Start the inactivity clock before iterating
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
    // AbortError from our inactivity timeout
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

// ---------------------------------------------------------------------------
// Heuristic (simple) summary -- used as fallback when 9b is unavailable
// ---------------------------------------------------------------------------

function simpleSummary(preparation: any, branchEntries?: any[]): string {
  let messages = [...(preparation?.messagesToSummarize || []), ...(preparation?.turnPrefixMessages || [])];
  // When preparation messages are empty, fall back to branchEntries
  if (messages.length === 0 && branchEntries && branchEntries.length > 0) {
    messages = getMessagesFromBranchEntries(branchEntries);
  }
  const userMessages = messages.filter((m: any) => m?.role === "user");
  const assistantMessages = messages.filter((m: any) => m?.role === "assistant");
  const lastUser = userMessages.length > 0 ? extractText(userMessages[userMessages.length - 1]?.content || "") : "";
  const lastAssistant = assistantMessages.length > 0 ? extractText(assistantMessages[assistantMessages.length - 1]?.content || "") : "";
  const prev = typeof preparation?.previousSummary === "string" ? preparation.previousSummary.trim() : "";

  return [
    "## Goal",
    truncate(lastUser || "Continue current task from previous context.", 700),
    "",
    "## Progress",
    "### Last Assistant Output",
    truncate(lastAssistant || "No assistant output available.", 1200),
    "",
    "## Critical Context",
    prev ? truncate(prev, 1800) : "No prior compaction summary available.",
    "",
    "## Next Steps",
    "1. Continue from the latest user request.",
    "2. Re-open relevant files and verify current workspace state.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Safe-compaction heuristic (edge cases where LLM summarization makes no sense)
// ---------------------------------------------------------------------------

function shouldUseSafeCompaction(preparation: any, ctx: ExtensionContext): { safe: boolean; reason: string } {
  const cw = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : 8192;
  const keepRecent = Number(preparation?.settings?.keepRecentTokens || 0);
  const reserve = Number(preparation?.settings?.reserveTokens || 0);
  const tokensBefore = Number(preparation?.tokensBefore || 0);

  if (tokensBefore > 0 && tokensBefore <= FORCE_SIMPLE_UNDER_TOKENS) {
    return { safe: true, reason: `tokens_before_small:${tokensBefore}` };
  }

  if (keepRecent >= cw - 1024) {
    return { safe: true, reason: `keep_recent_too_large:${keepRecent}/${cw}` };
  }

  if (reserve >= cw - 1024) {
    return { safe: true, reason: `reserve_too_large:${reserve}/${cw}` };
  }

  if (keepRecent + reserve >= cw - 512) {
    return { safe: true, reason: `keep_plus_reserve_too_large:${keepRecent + reserve}/${cw}` };
  }

  return { safe: false, reason: "" };
}

// ---------------------------------------------------------------------------
// 9b Model-based summarization
// ---------------------------------------------------------------------------

/**
 * Serialize messages to text for the 9b summarization prompt.
 * Similar to Pi's serializeConversation but with char budget enforcement.
 */
function serializeMessages(messages: any[], charBudget: number): string {
  const parts: string[] = [];
  let used = 0;

  for (const msg of messages) {
    if (used >= charBudget) break;

    const role = msg?.role || "unknown";
    let text = "";

    if (role === "user") {
      text = extractText(msg?.content);
    } else if (role === "assistant") {
      // Extract text blocks, skip thinking blocks for summarization
      const content = msg?.content;
      if (Array.isArray(content)) {
        const textParts: string[] = [];
        const toolCalls: string[] = [];
        for (const block of content) {
          if (block?.type === "text" && typeof block.text === "string") {
            // Strip thinking blocks embedded in text
            textParts.push(block.text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim());
          } else if (block?.type === "toolCall" && block.name) {
            const args = block.arguments || {};
            const argsStr = Object.entries(args)
              .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
              .join(", ");
            toolCalls.push(`${block.name}(${truncate(argsStr, 200)})`);
          }
        }
        if (textParts.length > 0) text += textParts.join("\n");
        if (toolCalls.length > 0) text += `\n[tool calls]: ${toolCalls.join("; ")}`;
      } else {
        text = extractText(content);
      }
    } else if (role === "toolResult") {
      const content = extractText(msg?.content);
      // Tool results can be very large; truncate aggressively
      text = content ? truncate(content, 800) : "";
    }

    if (!text || text.trim().length < 20) continue;

    const entry = `[${role}]: ${text}`;
    const remaining = charBudget - used;
    if (entry.length > remaining) {
      parts.push(truncate(entry, remaining));
      break;
    }
    parts.push(entry);
    used += entry.length + 2; // +2 for \n\n separator
  }

  return parts.join("\n\n");
}

// Summarization prompt (adapted from Pi's built-in)
const COMPACT_SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const COMPACT_UPDATE_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const COMPACT_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

/**
 * Resolve the sidecar model for compaction summarization.
 * Returns null if the model is not available.
 */
function resolveCompactionModel(ctx: ExtensionContext): any {
  const provider = ENV_COMPACTION_PROVIDER || resolveActiveProvider(ctx);
  const sc = getSidecarConfig(provider);
  const lookupProvider = ENV_COMPACTION_PROVIDER || resolveSidecarProvider(provider);
  const modelId = ENV_COMPACTION_MODEL || sc.compaction;
  const model = ctx.modelRegistry.find(lookupProvider, modelId);
  if (model) return model;

  trace("compaction_model_unavailable", { provider: lookupProvider, model: modelId });
  return null;
}

// ---------------------------------------------------------------------------
// DCS-powered summarization (opt-in, higher quality, higher latency)
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
 * Generate a compaction summary using the DCS research-agent pipeline.
 * Shells out to the globally installed `research-agent` CLI.
 * Returns the summary string on success, null on failure.
 */
async function generateSummaryWithDcs(
  conversationText: string,
  previousSummary: string
): Promise<string | null> {
  if (!DCS_COMPACTION_ENABLED) return null;

  const taskParts = [
    "Summarize this coding session conversation for context compaction.",
    "Retrieve relevant project knowledge from memory (YAMS) to enrich the summary with broader context.",
    "Produce a structured checkpoint summary with: Goal, Constraints, Progress (Done/In-Progress/Blocked), Key Decisions, Next Steps, Critical Context.",
    "Preserve exact file paths, function names, and error messages.",
  ];
  if (previousSummary) {
    taskParts.push(`\nPrevious compaction summary to UPDATE (preserve existing info, add new):\n<previous-summary>\n${truncate(previousSummary, 3000)}\n</previous-summary>`);
  }
  taskParts.push(`\n<conversation>\n${truncate(conversationText, 20000)}\n</conversation>`);

  const task = taskParts.join("\n");
  const args = ["run", task, "--context-profile", DCS_CONTEXT_PROFILE];

  trace("compaction_dcs_attempt", {
    cli: DCS_CLI,
    conversationChars: conversationText.length,
    hasPreviousSummary: !!previousSummary,
    timeoutMs: DCS_COMPACTION_TIMEOUT_MS,
  });

  try {
    const { stdout, stderr } = await execFileAsync(DCS_CLI, args, {
      timeout: DCS_COMPACTION_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });

    const output = extractDcsOutput(stdout || stderr || "");
    if (!output || output.length < 50) {
      trace("compaction_dcs_empty_output", {
        stdoutLen: (stdout || "").length,
        stderrLen: (stderr || "").length,
        outputLen: output.length,
      });
      return null;
    }

    // Strip any residual <think> blocks
    const cleaned = output.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

    trace("compaction_dcs_success", { summaryChars: cleaned.length });
    return cleaned;
  } catch (err: any) {
    const killed = err?.killed === true;
    const reason = killed ? "timeout" : "exec_error";
    trace("compaction_dcs_failed", {
      reason,
      killed,
      code: err?.code,
      error: String(err?.message || err).slice(0, 400),
      stderr: String(err?.stderr || "").slice(0, 300),
    });
    return null;
  }
}

/**
 * Generate a compaction summary using the 9b model.
 * Returns the summary string on success, null on failure (caller falls back to heuristic).
 */
async function generateSummaryWithSidecar(
  ctx: ExtensionContext,
  preparation: any,
  customInstructions?: string,
  branchEntries?: any[],
  overrideTimeoutMs?: number
): Promise<{ summary: string | null; failureReason: string }> {
  const model = resolveCompactionModel(ctx);
  if (!model) return { summary: null, failureReason: "model_not_found" };

  const apiKey = await ctx.modelRegistry.getApiKey(model);
  if (!apiKey) {
    trace("compaction_model_no_api_key", { modelId: model.id });
    return { summary: null, failureReason: "no_api_key" };
  }

  let messages = preparation?.messagesToSummarize || [];
  let source = "preparation";

  // When messagesToSummarize is empty, fall back to branchEntries
  if (messages.length === 0) {
    const tokensBefore = Number(preparation?.tokensBefore || 0);
    if (branchEntries && branchEntries.length > 0 && tokensBefore > 1000) {
      messages = getMessagesFromBranchEntries(branchEntries);
      source = "branch_entries";
      trace("compaction_using_branch_entries", {
        branchEntryCount: branchEntries.length,
        convertedMessageCount: messages.length,
        tokensBefore,
      });
    }
    if (messages.length === 0) {
      trace("compaction_no_messages", {
        tokensBefore,
        hasBranchEntries: !!(branchEntries && branchEntries.length > 0),
        reason: tokensBefore <= 1000 ? "tokens_too_low" : "no_usable_entries",
      });
      return { summary: null, failureReason: "no_messages" };
    }
  }

  // Serialize conversation with char budget
  const conversationText = serializeMessages(messages, COMPACTION_MAX_INPUT_CHARS);
  if (conversationText.trim().length < 50) {
    trace("compaction_conversation_too_short", { source, chars: conversationText.trim().length });
    return { summary: null, failureReason: "conversation_too_short" };
  }

  // Build prompt (use update prompt if we have a previous summary)
  const previousSummary = typeof preparation?.previousSummary === "string"
    ? preparation.previousSummary.trim()
    : "";

  let basePrompt = previousSummary ? COMPACT_UPDATE_PROMPT : COMPACT_SUMMARIZATION_PROMPT;
  if (customInstructions) {
    basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
  }

  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary) {
    promptText += `<previous-summary>\n${truncate(previousSummary, 4000)}\n</previous-summary>\n\n`;
  }
  promptText += basePrompt;

  trace("compaction_9b_attempt", {
    modelId: model.id,
    messageCount: messages.length,
    conversationChars: conversationText.length,
    hasPreviousSummary: !!previousSummary,
    source,
  });

  try {
    const response = await completeWithInactivityTimeout(
      model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: promptText }],
            timestamp: Date.now(),
          },
        ],
        systemPrompt: COMPACT_SYSTEM_PROMPT,
      },
      { apiKey, maxTokens: COMPACTION_MAX_TOKENS },
      overrideTimeoutMs ?? COMPACTION_INACTIVITY_MS
    );

    // Check for error response
    if ((response as any).stopReason === "error") {
      trace("compaction_9b_error_response", {
        modelId: model.id,
        errorMessage: (response as any).errorMessage || "unknown",
      });
      return { summary: null, failureReason: "model_error_response" };
    }

    const textContent = (response as any).content
      ?.filter((c: any) => c.type === "text")
      ?.map((c: any) => c.text)
      ?.join("\n")
      ?.trim();

    if (!textContent || textContent.length < 50) {
      // Secondary extraction: 9b sometimes emits ONLY thinking-type blocks.
      // The thinking content is still a valid summary.
      const thinkingRaw = (response as any).content
        ?.filter((c: any) => c.type === "thinking")
        ?.map((c: any) => c.thinking || c.text || "")
        ?.join("\n")
        ?.trim();

      // Strip <think> wrappers if present in extracted thinking content
      const thinkingStripped = thinkingRaw
        ? thinkingRaw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim() || thinkingRaw.replace(/<\/?think>/gi, "").trim()
        : "";

      if (thinkingStripped && thinkingStripped.length >= 50) {
        trace("compaction_9b_using_thinking_fallback", {
          modelId: model.id,
          textChars: textContent?.length || 0,
          thinkingRawChars: thinkingRaw?.length || 0,
          afterStripChars: thinkingStripped.length,
        });

        // Use thinking content as the summary -- strip any remaining think tags
        const cleanedThinking = thinkingStripped.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
        return { summary: cleanedThinking || thinkingStripped, failureReason: "" };
      }

      trace("compaction_9b_empty_response", {
        modelId: model.id,
        responseChars: textContent?.length || 0,
        thinkingChars: thinkingStripped?.length || 0,
      });
      return { summary: null, failureReason: "empty_model_response" };
    }

    // Strip any residual <think> blocks from model output
    const cleaned = textContent.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

    trace("compaction_9b_success", {
      modelId: model.id,
      summaryChars: cleaned.length,
      messageCount: messages.length,
      source,
    });

    return { summary: cleaned, failureReason: "" };
  } catch (err: any) {
    const reason = err?.message?.includes("inactivity_timeout") ? "inactivity_timeout" : "error";
    trace("compaction_9b_failed", {
      modelId: model.id,
      reason,
      error: String(err).slice(0, 300),
    });
    return { summary: null, failureReason: `model_call_failed:${reason}` };
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function compactionGuardExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const cw = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : null;
    const compactionModel = resolveCompactionModel(ctx);
    const activeProvider = ENV_COMPACTION_PROVIDER || resolveActiveProvider(ctx);
    const compactionModelId = compactionModel?.id || (ENV_COMPACTION_MODEL || getSidecarConfig(activeProvider).compaction);
    const dcsLabel = DCS_COMPACTION_ENABLED ? "+dcs" : "";
    if (ctx.hasUI) {
      const t = ctx.ui.theme;
      ctx.ui.setStatus(
        "compaction-guard",
        `${t.fg("dim", "compact:")}${t.fg("accent", compactionModel ? `${compactionModelId}${dcsLabel}` : `heuristic${dcsLabel}`)}${t.fg("dim", ` ${ctx.model?.id || "unknown"}`)}`
      );
      ctx.ui.notify(`Compaction guard active (summarizer: ${DCS_COMPACTION_ENABLED ? "DCS->sidecar" : compactionModel ? compactionModelId : "heuristic"}).`);
    }
    trace("session_start", {
      model: ctx.model?.id,
      contextWindow: cw,
      compactionModel: compactionModel?.id || null,
      compactionProvider: activeProvider,
      dcsEnabled: DCS_COMPACTION_ENABLED,
    });
  });

  pi.registerCommand("compaction-guard-status", {
    description: "Show compaction guard status",
    handler: async (_args, ctx) => {
      const cw = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : 8192;
      const compactionModel = resolveCompactionModel(ctx);
      const msg = `compaction-guard active | model=${ctx.model?.id || "unknown"} | contextWindow=${cw} | summarizer=${compactionModel ? compactionModel.id : "heuristic"} | provider=${ENV_COMPACTION_PROVIDER || resolveActiveProvider(ctx)} | dcs=${DCS_COMPACTION_ENABLED ? "on" : "off"}`;
      if (ctx.hasUI) ctx.ui.notify(msg);
      trace("status", { model: ctx.model?.id, contextWindow: cw, compactionModel: compactionModel?.id || null, dcsEnabled: DCS_COMPACTION_ENABLED });
    },
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const prep = event.preparation as any;
    const safeCheck = shouldUseSafeCompaction(prep, ctx);

    trace("before_compact", {
      tokensBefore: prep?.tokensBefore,
      keepRecentTokens: prep?.settings?.keepRecentTokens,
      reserveTokens: prep?.settings?.reserveTokens,
      contextWindow: ctx.model?.contextWindow,
      safeCompaction: safeCheck.safe,
      safeReason: safeCheck.reason,
    });

    // Edge cases where even 9b summarization is unnecessary
    if (safeCheck.safe) {
      const safeBranchEntries = (event as any).branchEntries as any[] | undefined;
      const summary = simpleSummary(prep, safeBranchEntries);
      if (ctx.hasUI) {
        ctx.ui.notify(`Compaction guard: using safe compaction (${safeCheck.reason})`, "warning");
      }
      trace("safe_compaction_used", { reason: safeCheck.reason });
      return {
        compaction: {
          summary,
          firstKeptEntryId: prep.firstKeptEntryId,
          tokensBefore: prep.tokensBefore,
        },
      };
    }

    // Normal path: DCS (opt-in) -> 9b summarization -> heuristic
    const customInstructions = (event as any).customInstructions;
    const branchEntries = (event as any).branchEntries as any[] | undefined;

    // Build conversation text early -- DCS and 9b both need it
    let messagesForText = prep?.messagesToSummarize || [];
    if (messagesForText.length === 0 && branchEntries && branchEntries.length > 0) {
      messagesForText = getMessagesFromBranchEntries(branchEntries);
    }
    const conversationText = messagesForText.length > 0
      ? serializeMessages(messagesForText, COMPACTION_MAX_INPUT_CHARS)
      : "";
    const previousSummary = typeof prep?.previousSummary === "string" ? prep.previousSummary.trim() : "";

    // --- DCS attempt (opt-in, high quality, higher latency) ---
    if (DCS_COMPACTION_ENABLED && conversationText.trim().length >= 50) {
      const dcsSummary = await generateSummaryWithDcs(conversationText, previousSummary);
      if (dcsSummary) {
        if (ctx.hasUI) {
          ctx.ui.notify("Compaction guard: summarized with DCS research-agent.");
        }
        return {
          compaction: {
            summary: dcsSummary,
            firstKeptEntryId: prep.firstKeptEntryId,
            tokensBefore: prep.tokensBefore,
          },
        };
      }
      // DCS failed -- fall through to 9b
      if (ctx.hasUI) {
        ctx.ui.notify("Compaction guard: DCS summarization failed, falling back to 9b.", "warning");
      }
    }

    // --- 9b model attempt ---
    const { summary: modelSummary, failureReason } = await generateSummaryWithSidecar(ctx, prep, customInstructions, branchEntries);

    if (modelSummary) {
      if (ctx.hasUI) {
        ctx.ui.notify(`Compaction guard: summarized with sidecar model.`);
      }
      return {
        compaction: {
          summary: modelSummary,
          firstKeptEntryId: prep.firstKeptEntryId,
          tokensBefore: prep.tokensBefore,
        },
      };
    }

    // --- 9b retry on empty_model_response (GPU contention at turn boundary) ---
    if (failureReason === "empty_model_response") {
      const retryTimeoutMs = Math.round(COMPACTION_INACTIVITY_MS * 1.5);
      trace("compaction_9b_retry_attempt", {
        originalTimeoutMs: COMPACTION_INACTIVITY_MS,
        retryTimeoutMs,
        reason: failureReason,
      });

      // Retry with a higher inactivity timeout
      const { summary: retrySummary, failureReason: retryFailure } = await generateSummaryWithSidecar(
        ctx, prep, customInstructions, branchEntries, retryTimeoutMs
      );

      if (retrySummary) {
        trace("compaction_9b_retry_success", { summaryChars: retrySummary.length });
        if (ctx.hasUI) {
          ctx.ui.notify(`Compaction guard: summarized with sidecar model (retry).`);
        }
        return {
          compaction: {
            summary: retrySummary,
            firstKeptEntryId: prep.firstKeptEntryId,
            tokensBefore: prep.tokensBefore,
          },
        };
      }

      trace("compaction_9b_retry_failed", { retryFailure });
    }

    // 9b failed -- fall back to heuristic summary (never let Pi call the 35b)
    const heuristicSummary = simpleSummary(prep, branchEntries);

    // Show actual failure reason instead of misleading "9b unavailable"
    const reasonLabel =
      failureReason === "model_not_found" ? "9b model not found in registry" :
      failureReason === "no_messages" ? "no messages to summarize (empty after branch-entry fallback)" :
      failureReason === "conversation_too_short" ? "conversation text too short for summarization" :
      failureReason.startsWith("model_call_failed:") ? `9b model call failed (${failureReason.split(":")[1]})` :
      `9b summarization failed (${failureReason || "unknown"})`;

    if (ctx.hasUI) {
      ctx.ui.notify(`Compaction guard: ${reasonLabel}, using heuristic summary.`, "warning");
    }
    trace("compaction_heuristic_fallback", {
      reason: failureReason || "unknown",
      messageCount: prep?.messagesToSummarize?.length || 0,
      branchEntryCount: branchEntries?.length || 0,
    });

    return {
      compaction: {
        summary: heuristicSummary,
        firstKeptEntryId: prep.firstKeptEntryId,
        tokensBefore: prep.tokensBefore,
      },
    };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx?.hasUI) ctx.ui.setStatus("compaction-guard", undefined);
  });
}
