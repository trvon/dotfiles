import fs from "node:fs";
import { homedir } from "node:os";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const TRACE_FILE = process.env.PI_COMPACTION_GUARD_TRACE_FILE || `${homedir()}/.pi/agent/compaction-guard.jsonl`;
const TRACE_ENABLED = parseBoolean(process.env.PI_COMPACTION_GUARD_TRACE_ENABLED, true);
const FORCE_SIMPLE_UNDER_TOKENS = parsePositiveInt(process.env.PI_COMPACTION_GUARD_FORCE_SIMPLE_UNDER_TOKENS, 512);

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

function trace(type: string, payload: Record<string, unknown> = {}): void {
  if (!TRACE_ENABLED) return;
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), type, ...payload });
    fs.appendFileSync(TRACE_FILE, `${line}\n`, "utf-8");
  } catch {
    // Ignore trace write errors.
  }
}

function simpleSummary(preparation: any): string {
  const messages = [...(preparation?.messagesToSummarize || []), ...(preparation?.turnPrefixMessages || [])];
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

export default function compactionGuardExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const cw = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : null;
    if (ctx.hasUI) {
      const t = ctx.ui.theme;
      ctx.ui.setStatus(
        "compaction-guard",
        `${t.fg("dim", "compact:")}${t.fg("accent", "guard")}${t.fg("dim", ` ${ctx.model?.id || "unknown"}`)}`
      );
      ctx.ui.notify("Compaction guard active.");
    }
    trace("session_start", { model: ctx.model?.id, contextWindow: cw });
  });

  pi.registerCommand("compaction-guard-status", {
    description: "Show compaction guard status",
    handler: async (_args, ctx) => {
      const cw = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : 8192;
      const msg = `compaction-guard active | model=${ctx.model?.id || "unknown"} | contextWindow=${cw}`;
      if (ctx.hasUI) ctx.ui.notify(msg);
      trace("status", { model: ctx.model?.id, contextWindow: cw });
    },
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const prep = event.preparation as any;
    const check = shouldUseSafeCompaction(prep, ctx);

    trace("before_compact", {
      tokensBefore: prep?.tokensBefore,
      keepRecentTokens: prep?.settings?.keepRecentTokens,
      reserveTokens: prep?.settings?.reserveTokens,
      contextWindow: ctx.model?.contextWindow,
      safe: check.safe,
      reason: check.reason,
    });

    if (!check.safe) return;

    const summary = simpleSummary(prep);
    if (ctx.hasUI) {
      ctx.ui.notify(`Compaction guard: using safe compaction (${check.reason})`, "warning");
    }
    trace("safe_compaction_used", { reason: check.reason });

    return {
      compaction: {
        summary,
        firstKeptEntryId: prep.firstKeptEntryId,
        tokensBefore: prep.tokensBefore,
      },
    };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx?.hasUI) ctx.ui.setStatus("compaction-guard", undefined);
  });
}
