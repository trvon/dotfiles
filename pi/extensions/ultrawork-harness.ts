import fs from "node:fs";
import { homedir } from "node:os";

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  addTask,
  buildObjectiveFromTasks,
  buildUltraworkPrompt,
  formatTaskList,
  getDispatchableTasks,
  makeEmptyStore,
  normalizePrompt,
  parseTaskCommand,
  sanitizeStore,
  setTaskStatus,
  type TaskStatus,
  type TaskStore,
} from "./ultrawork-core.ts";

type UltraworkState = {
  modeEnabled: boolean;
  store: TaskStore;
  runActive: boolean;
  runStartedAt: number | null;
  updatedAt: number;
};

const TRACE_FILE = process.env.PI_ULTRAWORK_TRACE_FILE || `${homedir()}/.pi/agent/ultrawork-harness.jsonl`;
const ULTRAWORK_ALWAYS_ON = parseBoolean(process.env.PI_ULTRAWORK_ALWAYS_ON, true);
const STATE_CUSTOM_TYPE = "ultrawork-state";
const ULTRAWORK_API_GUIDANCE = [
  "Ultrawork API contract:",
  "- Use tool 'ultrawork' as the primary delegation interface.",
  "- First call when uncertain: {\"action\":\"help\"}.",
  "- Bulk ingest: {\"action\":\"ingest_tasks\",\"tasks\":[...]}.",
  "- Dispatch: {\"action\":\"dispatch\"} or {\"action\":\"submit\",\"objective\":\"...\"}.",
].join("\n");

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

function renderStatusChip(ctx: ExtensionContext, modeEnabled: boolean): void {
  if (!ctx.hasUI) return;
  const t = ctx.ui.theme;
  const chip = modeEnabled
    ? `${t.fg("dim", "ultrawork:")}${t.fg("accent", "on")}`
    : `${t.fg("dim", "ultrawork:")}${t.fg("warning", "off")}`;
  ctx.ui.setStatus("ultrawork", chip);
}

function renderProgressBar(done: number, total: number, width = 8): string {
  if (total <= 0) return "[--------]";
  const ratio = Math.max(0, Math.min(1, done / total));
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return `[${"#".repeat(filled)}${"-".repeat(Math.max(0, width - filled))}]`;
}

function summarizeProgress(store: TaskStore): { done: number; total: number; bar: string } {
  const active = store.items.filter((i) => i.status !== "cancelled");
  const done = active.filter((i) => i.status === "done").length;
  const total = active.length;
  return { done, total, bar: renderProgressBar(done, total) };
}

function renderRuntimeStatus(ctx: ExtensionContext, state: UltraworkState): void {
  if (!ctx.hasUI) return;
  const t = ctx.ui.theme;
  const progress = summarizeProgress(state.store);
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
    const data = entry?.data as Partial<UltraworkState> | undefined;
    const store = sanitizeStore(data?.store);
    const modeEnabled = typeof data?.modeEnabled === "boolean" ? data.modeEnabled : ULTRAWORK_ALWAYS_ON;
    const runActive = false;
    const runStartedAt = null;
    const updatedAt = typeof data?.updatedAt === "number" ? data.updatedAt : Date.now();
    return { modeEnabled, store, runActive, runStartedAt, updatedAt };
  }
  return { modeEnabled: ULTRAWORK_ALWAYS_ON, store: makeEmptyStore(), runActive: false, runStartedAt: null, updatedAt: Date.now() };
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
  let state: UltraworkState = {
    modeEnabled: ULTRAWORK_ALWAYS_ON,
    store: makeEmptyStore(),
    runActive: false,
    runStartedAt: null,
    updatedAt: Date.now(),
  };

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
      if (action === "help") {
        const text = [
          ULTRAWORK_API_GUIDANCE,
          "",
          "ultrawork JSON API",
          "- action=help|status|submit|dispatch|ingest_tasks|list_tasks|add_task|set_task|mode|reset",
          "- submit/dispatch: objective optional; if omitted, queued tasks are dispatched",
          "- ingest_tasks: pass tasks[] in params or payload JSON",
          "- add_task: taskTitle required",
          "- set_task: taskId + taskStatus required (todo|in_progress|done|cancelled)",
          "- mode: on|off|status",
          "Examples:",
          '{"action":"add_task","taskTitle":"Fix compile warnings"}',
          '{"action":"ingest_tasks","tasks":[{"title":"Task A"},{"title":"Task B","status":"pending"}]}',
          '{"action":"set_task","taskId":1,"taskStatus":"in_progress"}',
          '{"action":"dispatch"}',
        ].join("\n");
        return { content: [{ type: "text", text }], details: toStateDetails(state) };
      }

      if (action === "status") {
        return {
          content: [{ type: "text", text: `ultrawork mode=${state.modeEnabled ? "on" : "off"} tasks=${state.store.items.length}` }],
          details: toStateDetails(state),
        };
      }

      if (action === "mode") {
        const mode = (params.mode || String(get("mode", "status"))).toLowerCase();
        if (mode === "on") state.modeEnabled = true;
        else if (mode === "off") state.modeEnabled = false;
        renderRuntimeStatus(ctx, state);
        persistState(pi, state);
        trace("mode", { mode: state.modeEnabled });
        return {
          content: [{ type: "text", text: `ultrawork mode=${state.modeEnabled ? "on" : "off"}` }],
          details: toStateDetails(state),
        };
      }

      if (action === "reset") {
        state.store = makeEmptyStore();
        persistState(pi, state);
        renderRuntimeStatus(ctx, state);
        trace("task_reset");
        return { content: [{ type: "text", text: "ultrawork tasks reset" }], details: toStateDetails(state) };
      }

      if (action === "list_tasks") {
        return {
          content: [{ type: "text", text: formatTaskList(state.store) }],
          details: toStateDetails(state),
        };
      }

      if (action === "add_task") {
        const title = normalizePrompt(params.taskTitle || String(get("taskTitle", "")).trim());
        if (!title) {
          return { content: [{ type: "text", text: "Error: taskTitle required" }], details: toStateDetails(state) };
        }
        const item = addTask(state.store, title);
        persistState(pi, state);
        renderRuntimeStatus(ctx, state);
        trace("task_add", { id: item.id, title: item.title });
        return {
          content: [{ type: "text", text: `task added #${item.id} ${item.title}` }],
          details: toStateDetails(state),
        };
      }

      if (action === "ingest_tasks") {
        const rawTasks = Array.isArray(params.tasks)
          ? params.tasks
          : (Array.isArray(get("tasks", [])) ? (get("tasks", []) as Array<any>) : []);
        const dedupe = (params.dedupe ?? Boolean(get("dedupe", true))) !== false;
        if (!rawTasks.length) {
          return { content: [{ type: "text", text: "Error: ingest_tasks requires non-empty tasks array" }], details: toStateDetails(state) };
        }

        const existing = new Set(state.store.items.map((t) => normalizePrompt(t.title).toLowerCase()));
        let added = 0;
        let skipped = 0;
        for (const row of rawTasks) {
          const title = normalizePrompt(String(row?.title || "")).trim();
          if (!title) {
            skipped += 1;
            continue;
          }
          const key = title.toLowerCase();
          if (dedupe && existing.has(key)) {
            skipped += 1;
            continue;
          }
          const item = addTask(state.store, title);
          const rawStatus = String(row?.status || "todo").trim().toLowerCase();
          const status = rawStatus === "pending" ? "todo" : rawStatus;
          if (status === "in_progress" || status === "done" || status === "cancelled") {
            item.status = status;
            item.updatedAt = Date.now();
          }
          existing.add(key);
          added += 1;
        }

        persistState(pi, state);
        renderRuntimeStatus(ctx, state);
        trace("task_ingest", { added, skipped, dedupe, total: rawTasks.length });
        return {
          content: [{ type: "text", text: `ingested tasks: added=${added} skipped=${skipped} total=${rawTasks.length}` }],
          details: toStateDetails(state),
        };
      }

      if (action === "set_task") {
        const taskId = Number(params.taskId ?? get("taskId", NaN));
        const taskStatus = String(params.taskStatus || get("taskStatus", "")).trim().toLowerCase() as TaskStatus;
        if (!Number.isFinite(taskId) || !["todo", "in_progress", "done", "cancelled"].includes(taskStatus)) {
          return { content: [{ type: "text", text: "Error: set_task requires taskId + taskStatus" }], details: toStateDetails(state) };
        }
        const targetStatus = taskStatus === "todo" ? "in_progress" : taskStatus;
        const updated = setTaskStatus(state.store, taskId, targetStatus as "in_progress" | "done" | "cancelled");
        if (!updated) return { content: [{ type: "text", text: `Error: task #${taskId} not found` }], details: toStateDetails(state) };
        if (taskStatus === "todo") {
          updated.status = "todo";
          updated.updatedAt = Date.now();
        }
        persistState(pi, state);
        renderRuntimeStatus(ctx, state);
        trace("task_update", { id: updated.id, status: updated.status });
        return { content: [{ type: "text", text: `task #${updated.id} -> ${updated.status}` }], details: toStateDetails(state) };
      }

      if (action === "submit" || action === "dispatch") {
        const explicitObjective = normalizePrompt(params.objective || String(get("objective", "")).trim());
        const objective = explicitObjective || buildObjectiveFromTasks(state.store) || "";
        if (!objective) {
          return { content: [{ type: "text", text: "Error: no objective and no queued tasks" }], details: toStateDetails(state) };
        }

        if (!explicitObjective) {
          const queued = getDispatchableTasks(state.store);
          for (const item of queued) {
            if (item.status === "todo") {
              item.status = "in_progress";
              item.updatedAt = Date.now();
            }
          }
        }

        state.modeEnabled = true;
        state.runActive = true;
        state.runStartedAt = Date.now();
        renderRuntimeStatus(ctx, state);
        persistState(pi, state);

        const message = buildUltraworkPrompt(objective);
        if (ctx.isIdle()) pi.sendUserMessage(message);
        else pi.sendUserMessage(message, { deliverAs: "followUp" });

        trace("ultrawork_dispatch", {
          explicitObjective: Boolean(explicitObjective),
          objectiveChars: objective.length,
          queued: getDispatchableTasks(state.store).length,
          idle: ctx.isIdle(),
        });
        trace("ultrawork_run_started", { source: "tool", objectiveChars: objective.length });

        return {
          content: [{ type: "text", text: `ultrawork dispatched (${explicitObjective ? "explicit objective" : "queued tasks"})` }],
          details: toStateDetails(state),
        };
      }

      return {
        content: [{ type: "text", text: `Unknown action: ${action}` }],
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
        notify(ctx, formatTaskList(state.store));
        return;
      }
      if (parsed.action === "reset") {
        state.store = makeEmptyStore();
        persistState(pi, state);
        renderRuntimeStatus(ctx, state);
        notify(ctx, "Tasks cleared.");
        return;
      }
      if (parsed.action === "add") {
        const item = addTask(state.store, parsed.title);
        persistState(pi, state);
        renderRuntimeStatus(ctx, state);
        notify(ctx, `Task added: #${item.id} ${item.title}`);
        return;
      }
      const updated = setTaskStatus(state.store, parsed.id, parsed.status);
      if (!updated) {
        notify(ctx, `Task #${parsed.id} not found.`, "warning");
        return;
      }
      persistState(pi, state);
      renderRuntimeStatus(ctx, state);
      notify(ctx, `Task #${updated.id} -> ${updated.status}`);
    },
  });

  pi.registerCommand("ultrawork", {
    description: "Dispatch ultrawork objective (or queued tasks if omitted)",
    handler: async (args, ctx) => {
      const objective = normalizePrompt((args || "").trim());
      const effective = objective || buildObjectiveFromTasks(state.store) || "";
      if (!effective) {
        notify(ctx, "No queued tasks found. Add tasks with /task add <title> or run /ultrawork <objective>.", "warning");
        return;
      }
      state.modeEnabled = true;
      state.runActive = true;
      state.runStartedAt = Date.now();
      renderRuntimeStatus(ctx, state);
      persistState(pi, state);
      const msg = buildUltraworkPrompt(effective);
      if (ctx.isIdle()) pi.sendUserMessage(msg);
      else pi.sendUserMessage(msg, { deliverAs: "followUp" });
      trace("ultrawork_dispatch", { command: true, objectiveChars: effective.length, explicit: Boolean(objective) });
      trace("ultrawork_run_started", { source: "command", objectiveChars: effective.length });
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
