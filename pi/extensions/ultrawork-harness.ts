import fs from "node:fs";
import { homedir } from "node:os";

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  buildObjectiveFromTasks,
  buildUltraworkPrompt,
  normalizePrompt,
  parseTaskCommand,
} from "./ultrawork-core.ts";
import {
  ULTRAWORK_API_GUIDANCE,
  applyUltraworkAction,
  createInitialUltraworkState,
  sanitizeUltraworkState,
  summarizeProgress,
  type UltraworkAction,
  type UltraworkState,
} from "./ultrawork-actions.ts";

const TRACE_FILE = process.env.PI_ULTRAWORK_TRACE_FILE || `${homedir()}/.pi/agent/ultrawork-harness.jsonl`;
const ULTRAWORK_ALWAYS_ON = parseBoolean(process.env.PI_ULTRAWORK_ALWAYS_ON, true);
const STATE_CUSTOM_TYPE = "ultrawork-state";

const UltraworkParams = Type.Object({
  action: StringEnum([
    "help",
    "status",
    "submit",
    "dispatch",
    "ingest_tasks",
    "list_tasks",
    "add_task",
    "set_task",
    "mode",
    "reset",
  ] as const),
  objective: Type.Optional(Type.String({ description: "Objective text for submit/dispatch" })),
  taskTitle: Type.Optional(Type.String({ description: "Task title for add_task" })),
  taskId: Type.Optional(Type.Number({ description: "Task id for set_task" })),
  taskStatus: Type.Optional(StringEnum(["todo", "in_progress", "done", "cancelled"] as const)),
  tasks: Type.Optional(
    Type.Array(
      Type.Object({
        title: Type.String({ description: "Task title" }),
        status: Type.Optional(StringEnum(["todo", "pending", "in_progress", "done", "cancelled"] as const)),
      })
    )
  ),
  dedupe: Type.Optional(Type.Boolean({ description: "Skip exact-title duplicates (default: true)" })),
  mode: Type.Optional(StringEnum(["on", "off", "status"] as const)),
  payload: Type.Optional(Type.String({ description: "JSON payload interface" })),
});

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function trace(type: string, payload: Record<string, unknown> = {}): void {
  if (!TRACE_FILE) return;
  try {
    fs.appendFileSync(TRACE_FILE, `${JSON.stringify({ ts: new Date().toISOString(), type, ...payload })}\n`, "utf-8");
  } catch {
    // ignore
  }
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  if (!ctx.hasUI) return;
  ctx.ui.notify(message, type);
}

function renderProgressBar(done: number, total: number, width = 8): string {
  if (total <= 0) return "[--------]";
  const ratio = Math.max(0, Math.min(1, done / total));
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return `[${"#".repeat(filled)}${"-".repeat(Math.max(0, width - filled))}]`;
}

function renderRuntimeStatus(ctx: ExtensionContext, state: UltraworkState): void {
  if (!ctx.hasUI) return;
  const t = ctx.ui.theme;
  const progressBase = summarizeProgress(state.store);
  const progress = { ...progressBase, bar: renderProgressBar(progressBase.done, progressBase.total) };
  const mode = state.modeEnabled ? t.fg("accent", "on") : t.fg("warning", "off");
  const run = state.runActive ? t.fg("success", "running") : t.fg("dim", "idle");
  ctx.ui.setStatus("ultrawork", `${t.fg("dim", "ultrawork:")}${mode} ${run} ${progress.done}/${progress.total} ${progress.bar}`);
}

function toStateDetails(state: UltraworkState) {
  const progress = summarizeProgress(state.store);
  return {
    modeEnabled: state.modeEnabled,
    runActive: state.runActive,
    runStartedAt: state.runStartedAt,
    progress,
    store: state.store,
    updatedAt: state.updatedAt,
  };
}

function reconstructState(ctx: ExtensionContext): UltraworkState {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as any;
    if (entry?.type !== "custom" || entry?.customType !== STATE_CUSTOM_TYPE) continue;
    return sanitizeUltraworkState(entry?.data, ULTRAWORK_ALWAYS_ON);
  }
  return createInitialUltraworkState(ULTRAWORK_ALWAYS_ON);
}

function persistState(pi: ExtensionAPI, state: UltraworkState): void {
  state.updatedAt = Date.now();
  pi.appendEntry(STATE_CUSTOM_TYPE, toStateDetails(state));
}

function parseToolPayload(payload: string | undefined): Record<string, unknown> {
  if (!payload || !payload.trim()) return {};
  try {
    const parsed = JSON.parse(payload);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

export default function ultraworkHarnessExtension(pi: ExtensionAPI): void {
  let state: UltraworkState = createInitialUltraworkState(ULTRAWORK_ALWAYS_ON);

  async function dispatchObjective(ctx: ExtensionContext, objective: string): Promise<void> {
    const message = buildUltraworkPrompt(objective);
    try {
      if (ctx.isIdle()) pi.sendUserMessage(message);
      else pi.sendUserMessage(message, { deliverAs: "followUp" });
    } catch (error: any) {
      const text = String(error?.message || error || "").toLowerCase();
      if (text.includes("already processing a prompt") || text.includes("agent is busy")) {
        pi.sendUserMessage(message, { deliverAs: "followUp" });
        trace("ultrawork_dispatch_queued_busy", { objectiveChars: objective.length });
        return;
      }
      throw error;
    }
  }

  async function executeAction(action: UltraworkAction, ctx: ExtensionContext): Promise<{ text: string; ok: boolean }> {
    const result = applyUltraworkAction(state, action);
    state = result.state;
    persistState(pi, state);
    renderRuntimeStatus(ctx, state);

    for (const change of result.changes) {
      if (change === "task_add") {
        const last = state.store.items[state.store.items.length - 1];
        if (last) trace("task_add", { id: last.id, title: last.title });
      } else if (change === "task_update") {
        trace("task_update", { taskCount: state.store.items.length });
      } else if (change === "task_ingest") {
        trace("task_ingest", { taskCount: state.store.items.length });
      } else if (change === "mode_on" || change === "mode_off") {
        trace("mode", { mode: state.modeEnabled });
      } else if (change === "reset") {
        trace("task_reset");
      }
    }

    if (result.dispatchObjective) {
      await dispatchObjective(ctx, result.dispatchObjective);
      trace("ultrawork_dispatch", {
        objectiveChars: result.dispatchObjective.length,
        queued: state.store.items.length,
        idle: ctx.isIdle(),
      });
      trace("ultrawork_run_started", { source: "action", objectiveChars: result.dispatchObjective.length });
    }

    return { text: result.text, ok: result.ok };
  }

  pi.on("session_start", async (_event, ctx) => {
    state = reconstructState(ctx);
    renderRuntimeStatus(ctx, state);
    trace("session_start", { mode: state.modeEnabled, taskCount: state.store.items.length, alwaysOn: ULTRAWORK_ALWAYS_ON });
    notify(ctx, "Ultrawork API ready. Use tool 'ultrawork' (action=help for schema).", "info");
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (state.runActive) renderRuntimeStatus(ctx, state);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!state.runActive) return;
    const durationMs = state.runStartedAt ? Date.now() - state.runStartedAt : null;
    state.runActive = false;
    state.runStartedAt = null;
    persistState(pi, state);
    renderRuntimeStatus(ctx, state);
    trace("ultrawork_run_finished", { durationMs, done: summarizeProgress(state.store).done, total: summarizeProgress(state.store).total });
  });

  pi.registerTool({
    name: "ultrawork",
    label: "Ultrawork",
    description: "Primary JSON API for ultrawork orchestration/task delegation. Use actions: help, status, submit, dispatch, ingest_tasks, list_tasks, add_task, set_task, mode, reset.",
    parameters: UltraworkParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const payload = parseToolPayload(params.payload);
      const get = <T>(key: string, fallback: T): T => (key in payload ? (payload[key] as T) : fallback);

      const action = params.action;
      const mappedAction: UltraworkAction = (
        action === "help" ? { action } :
        action === "status" ? { action } :
        action === "mode" ? { action, mode: (params.mode || String(get("mode", "status")).toLowerCase() as any) } :
        action === "reset" ? { action } :
        action === "list_tasks" ? { action } :
        action === "add_task" ? { action, taskTitle: params.taskTitle || String(get("taskTitle", "")).trim() } :
        action === "ingest_tasks" ? {
          action,
          tasks: Array.isArray(params.tasks) ? (params.tasks as any) : (Array.isArray(get("tasks", [])) ? (get("tasks", []) as any) : []),
          dedupe: (params.dedupe ?? Boolean(get("dedupe", true))) !== false,
        } :
        action === "set_task" ? {
          action,
          taskId: Number(params.taskId ?? get("taskId", NaN)),
          taskStatus: String(params.taskStatus || get("taskStatus", "")).trim().toLowerCase() as any,
        } :
        action === "submit" ? { action, objective: params.objective || String(get("objective", "")).trim() } :
        { action: "dispatch", objective: params.objective || String(get("objective", "")).trim() }
      );

      const out = await executeAction(mappedAction, ctx);
      return {
        content: [{ type: "text", text: out.text }],
        details: toStateDetails(state),
      };
    },
  });

  // Convenience user command wrappers over the ultrawork API interface.
  pi.registerCommand("task", {
    description: "Task wrapper over ultrawork API (list|add|start|done|cancel|reset)",
    handler: async (args, ctx) => {
      const parsed = parseTaskCommand(args || "");
      if (parsed.action === "invalid") {
        notify(ctx, parsed.usage, "warning");
        return;
      }
      if (parsed.action === "list") {
        const out = await executeAction({ action: "list_tasks" }, ctx);
        notify(ctx, out.text);
        return;
      }
      if (parsed.action === "reset") {
        const out = await executeAction({ action: "reset" }, ctx);
        notify(ctx, out.text);
        return;
      }
      if (parsed.action === "add") {
        const out = await executeAction({ action: "add_task", taskTitle: parsed.title }, ctx);
        notify(ctx, out.text, out.ok ? "info" : "warning");
        return;
      }
      const out = await executeAction({ action: "set_task", taskId: parsed.id, taskStatus: parsed.status as any }, ctx);
      notify(ctx, out.text, out.ok ? "info" : "warning");
    },
  });

  pi.registerCommand("ultrawork", {
    description: "Dispatch ultrawork objective (or queued tasks if omitted)",
    handler: async (args, ctx) => {
      const objective = normalizePrompt((args || "").trim());
      const out = await executeAction({ action: objective ? "submit" : "dispatch", objective }, ctx);
      if (!out.ok) {
        notify(ctx, "No queued tasks found. Add tasks with /task add <title> or run /ultrawork <objective>.", "warning");
        return;
      }
      notify(ctx, objective ? "Ultrawork dispatched from objective." : "Ultrawork dispatched from queued tasks.");
    },
  });

  pi.registerCommand("ultrawork-help", {
    description: "Show ultrawork JSON API usage",
    handler: async (_args, ctx) => {
      notify(
        ctx,
        [
          ULTRAWORK_API_GUIDANCE,
          "",
          "Ultrawork JSON API:",
          "actions: help, status, submit, dispatch, ingest_tasks, list_tasks, add_task, set_task, mode, reset",
          "examples:",
          '- tool ultrawork {"action":"add_task","taskTitle":"Implement modal fade"}',
          '- tool ultrawork {"action":"ingest_tasks","tasks":[{"title":"Task A"},{"title":"Task B","status":"pending"}]}',
          '- tool ultrawork {"action":"dispatch"}',
          '- tool ultrawork {"action":"set_task","taskId":1,"taskStatus":"done"}',
        ].join("\n")
      );
    },
  });

  pi.registerCommand("ultrawork-api", {
    description: "Show ultrawork API contract and examples",
    handler: async (_args, ctx) => {
      notify(ctx, ULTRAWORK_API_GUIDANCE);
    },
  });

  pi.on("before_agent_start", async (event) => {
    if (!state.modeEnabled) return;
    const prompt = typeof event?.prompt === "string" ? event.prompt : "";
    if (!prompt || /\[ultrawork-inline\]/i.test(prompt)) return;
    const normalized = normalizePrompt(prompt);
    const injected = [
      "[ultrawork-inline]",
      "Parallelize independent operations where safe; keep dependent steps sequential.",
      "Use ultrawork tool JSON interface for delegation/state (actions: add_task, set_task, submit, dispatch, status).",
      "If unsure, call ultrawork action=help first.",
      "Return one merged result with deduped conclusions.",
      normalized,
    ].join("\n");
    trace("ultrawork_inline", { originalChars: prompt.length, injectedChars: injected.length, mode: state.modeEnabled });
    return { prompt: injected } as any;
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("ultrawork", undefined);
  });
}
