import {
  addTask,
  buildObjectiveFromTasks,
  formatTaskList,
  getDispatchableTasks,
  makeEmptyStore,
  normalizePrompt,
  sanitizeStore,
  setTaskStatus,
  type TaskStatus,
  type TaskStore,
} from "./ultrawork-core.ts";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export type UltraworkState = {
  modeEnabled: boolean;
  store: TaskStore;
  runActive: boolean;
  runStartedAt: number | null;
  updatedAt: number;
};

export type UltraworkAction =
  | { action: "help" }
  | { action: "status" }
  | { action: "mode"; mode?: "on" | "off" | "status" }
  | { action: "reset" }
  | { action: "list_tasks" }
  | { action: "add_task"; taskTitle?: string }
  | { action: "ingest_tasks"; tasks?: Array<{ title?: string; status?: string }>; dedupe?: boolean }
  | { action: "set_task"; taskId?: number; taskStatus?: TaskStatus }
  | { action: "submit"; objective?: string }
  | { action: "dispatch"; objective?: string };

export type UltraworkActionResult = {
  ok: boolean;
  text: string;
  state: UltraworkState;
  changes: string[];
  dispatchObjective?: string;
};

export const ULTRAWORK_API_GUIDANCE = [
  "Ultrawork API contract:",
  "- Use tool 'ultrawork' as the primary delegation interface.",
  "- First call when uncertain: {\"action\":\"help\"}.",
  "- Bulk ingest: {\"action\":\"ingest_tasks\",\"tasks\":[...]}.",
  "- Dispatch: {\"action\":\"dispatch\"} or {\"action\":\"submit\",\"objective\":\"...\"}.",
].join("\n");

export function createInitialUltraworkState(alwaysOn: boolean): UltraworkState {
  return {
    modeEnabled: alwaysOn,
    store: makeEmptyStore(),
    runActive: false,
    runStartedAt: null,
    updatedAt: Date.now(),
  };
}

export function sanitizeUltraworkState(input: unknown, alwaysOn: boolean): UltraworkState {
  const raw = (input && typeof input === "object") ? (input as Partial<UltraworkState>) : {};
  return {
    modeEnabled: typeof raw.modeEnabled === "boolean" ? raw.modeEnabled : alwaysOn,
    store: sanitizeStore(raw.store),
    runActive: false,
    runStartedAt: null,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
  };
}

export function summarizeProgress(store: TaskStore): { done: number; total: number } {
  const active = store.items.filter((i) => i.status !== "cancelled");
  const done = active.filter((i) => i.status === "done").length;
  return { done, total: active.length };
}

export function applyUltraworkAction(
  state: UltraworkState,
  action: UltraworkAction,
): UltraworkActionResult {
  const next: UltraworkState = {
    ...state,
    store: {
      nextId: state.store.nextId,
      items: state.store.items.map((item) => ({ ...item })),
    },
    updatedAt: Date.now(),
  };
  const changes: string[] = [];

  if (action.action === "help") {
    return {
      ok: true,
      text: [
        ULTRAWORK_API_GUIDANCE,
        "",
        "ultrawork JSON API",
        "- action=help|status|submit|dispatch|ingest_tasks|list_tasks|add_task|set_task|mode|reset",
        "- submit/dispatch: objective optional; if omitted, queued tasks are dispatched",
        "- ingest_tasks: pass tasks[] in params or payload JSON",
        "- add_task: taskTitle required",
        "- set_task: taskId + taskStatus required (todo|in_progress|done|cancelled)",
        "- mode: on|off|status",
      ].join("\n"),
      state: next,
      changes,
    };
  }

  if (action.action === "status") {
    const p = summarizeProgress(next.store);
    return {
      ok: true,
      text: `ultrawork mode=${next.modeEnabled ? "on" : "off"} run=${next.runActive ? "running" : "idle"} tasks=${next.store.items.length} progress=${p.done}/${p.total}`,
      state: next,
      changes,
    };
  }

  if (action.action === "mode") {
    const mode = (action.mode || "status").toLowerCase();
    if (mode === "on") {
      next.modeEnabled = true;
      changes.push("mode_on");
    } else if (mode === "off") {
      next.modeEnabled = false;
      changes.push("mode_off");
    }
    return { ok: true, text: `ultrawork mode=${next.modeEnabled ? "on" : "off"}`, state: next, changes };
  }

  if (action.action === "reset") {
    next.store = makeEmptyStore();
    next.runActive = false;
    next.runStartedAt = null;
    changes.push("reset");
    return { ok: true, text: "ultrawork tasks reset", state: next, changes };
  }

  if (action.action === "list_tasks") {
    return { ok: true, text: formatTaskList(next.store), state: next, changes };
  }

  if (action.action === "add_task") {
    const title = normalizePrompt(action.taskTitle || "").trim();
    if (!title) return { ok: false, text: "Error: taskTitle required", state: next, changes };
    const item = addTask(next.store, title);
    changes.push("task_add");
    return { ok: true, text: `task added #${item.id} ${item.title}`, state: next, changes };
  }

  if (action.action === "ingest_tasks") {
    const rows = Array.isArray(action.tasks) ? action.tasks : [];
    if (!rows.length) return { ok: false, text: "Error: ingest_tasks requires non-empty tasks array", state: next, changes };
    const dedupe = action.dedupe !== false;
    const existing = new Set(next.store.items.map((t) => normalizePrompt(t.title).toLowerCase()));
    let added = 0;
    let skipped = 0;
    for (const row of rows) {
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
      const item = addTask(next.store, title);
      const rawStatus = String(row?.status || "todo").trim().toLowerCase();
      const status = rawStatus === "pending" ? "todo" : rawStatus;
      if (status === "in_progress" || status === "done" || status === "cancelled") {
        item.status = status;
        item.updatedAt = Date.now();
      }
      existing.add(key);
      added += 1;
    }
    changes.push("task_ingest");
    return { ok: true, text: `ingested tasks: added=${added} skipped=${skipped} total=${rows.length}`, state: next, changes };
  }

  if (action.action === "set_task") {
    const taskId = Number(action.taskId);
    const taskStatus = String(action.taskStatus || "").trim().toLowerCase() as TaskStatus;
    if (!Number.isFinite(taskId) || !["todo", "in_progress", "done", "cancelled"].includes(taskStatus)) {
      return { ok: false, text: "Error: set_task requires taskId + taskStatus", state: next, changes };
    }
    const targetStatus = taskStatus === "todo" ? "in_progress" : taskStatus;
    const updated = setTaskStatus(next.store, taskId, targetStatus as "in_progress" | "done" | "cancelled");
    if (!updated) return { ok: false, text: `Error: task #${taskId} not found`, state: next, changes };
    if (taskStatus === "todo") {
      updated.status = "todo";
      updated.updatedAt = Date.now();
    }
    changes.push("task_update");
    return { ok: true, text: `task #${updated.id} -> ${updated.status}`, state: next, changes };
  }

  if (action.action === "submit" || action.action === "dispatch") {
    const explicitObjective = normalizePrompt(action.objective || "").trim();
    const objective = explicitObjective || buildObjectiveFromTasks(next.store) || "";
    if (!objective) return { ok: false, text: "Error: no objective and no queued tasks", state: next, changes };
    if (!explicitObjective) {
      const queued = getDispatchableTasks(next.store);
      for (const item of queued) {
        if (item.status === "todo") {
          item.status = "in_progress";
          item.updatedAt = Date.now();
        }
      }
    }
    next.modeEnabled = true;
    next.runActive = true;
    next.runStartedAt = Date.now();
    changes.push("dispatch");
    return {
      ok: true,
      text: `ultrawork dispatched (${explicitObjective ? "explicit objective" : "queued tasks"})`,
      state: next,
      changes,
      dispatchObjective: objective,
    };
  }

  return { ok: false, text: "Error: unknown action", state: next, changes };
}

// No-op extension factory so Pi's extension loader can safely load this utility module.
export default function ultraworkActionsNoopExtension(_pi: ExtensionAPI): void {
  // intentionally empty
}
