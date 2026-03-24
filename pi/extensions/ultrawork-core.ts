export type TaskStatus = "todo" | "in_progress" | "done" | "cancelled";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export type TaskItem = {
  id: number;
  title: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
};

export type TaskStore = {
  nextId: number;
  items: TaskItem[];
};

export type TaskCommand =
  | { action: "list" }
  | { action: "reset" }
  | { action: "add"; title: string }
  | { action: "set"; id: number; status: Exclude<TaskStatus, "todo"> }
  | { action: "invalid"; usage: string };

export function normalizePrompt(prompt: string): string {
  return prompt
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildUltraworkPrompt(goal: string): string {
  return [
    "[ultrawork]",
    "Use parallel orchestration mode.",
    "Split work into 3-6 independent streams and execute independent tool calls in parallel.",
    "Keep one canonical progress list; do not duplicate finished work.",
    "Merge outputs into a single concise synthesis with concrete file-level changes.",
    `Goal: ${goal}`,
  ].join("\n");
}

export function makeEmptyStore(): TaskStore {
  return { nextId: 1, items: [] };
}

export function sanitizeStore(parsed: unknown, now = Date.now()): TaskStore {
  if (!parsed || typeof parsed !== "object") return makeEmptyStore();
  const p = parsed as Partial<TaskStore>;
  const itemsRaw = Array.isArray(p.items) ? p.items : [];
  const items: TaskItem[] = itemsRaw
    .filter((i: any) => i && typeof i.id === "number" && typeof i.title === "string")
    .map((i: any) => ({
      id: i.id,
      title: i.title,
      status: (() => {
        const raw = String(i.status || "").trim().toLowerCase();
        if (raw === "pending") return "todo";
        if (["todo", "in_progress", "done", "cancelled"].includes(raw)) return raw as TaskStatus;
        return "todo";
      })(),
      createdAt: typeof i.createdAt === "number" ? i.createdAt : now,
      updatedAt: typeof i.updatedAt === "number" ? i.updatedAt : now,
    }));
  const nextId = typeof p.nextId === "number"
    ? p.nextId
    : items.reduce((m, i) => Math.max(m, i.id), 0) + 1;
  return { nextId, items };
}

export function addTask(store: TaskStore, title: string, now = Date.now()): TaskItem {
  const item: TaskItem = {
    id: store.nextId,
    title,
    status: "todo",
    createdAt: now,
    updatedAt: now,
  };
  store.nextId += 1;
  store.items.push(item);
  return item;
}

export function setTaskStatus(
  store: TaskStore,
  id: number,
  status: Exclude<TaskStatus, "todo">,
  now = Date.now()
): TaskItem | null {
  const item = store.items.find((t) => t.id === id);
  if (!item) return null;
  item.status = status;
  item.updatedAt = now;
  return item;
}

export function formatTaskList(store: TaskStore): string {
  if (store.items.length === 0) return "Tasks: none";
  const lines = store.items
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((item) => `#${item.id} [${item.status}] ${item.title}`);
  return `Tasks:\n${lines.join("\n")}`;
}

export function getDispatchableTasks(store: TaskStore): TaskItem[] {
  return store.items
    .filter((item) => item.status === "todo" || item.status === "in_progress")
    .sort((a, b) => a.id - b.id);
}

export function buildObjectiveFromTasks(store: TaskStore): string | null {
  const items = getDispatchableTasks(store);
  if (items.length === 0) return null;
  const lines = items.map((item) => `- [#${item.id}] ${item.title}`);
  return [
    "Execute all queued ultrawork tasks in parallel where safe.",
    "Tasks:",
    ...lines,
    "Mark completed items done and leave blocked items in_progress with reason.",
  ].join("\n");
}

export function parseTaskCommand(raw: string): TaskCommand {
  const input = (raw || "").trim();
  if (!input) return { action: "list" };
  const [head, ...rest] = input.split(/\s+/);
  const cmd = head.toLowerCase();
  if (cmd === "list") return { action: "list" };
  if (cmd === "reset") return { action: "reset" };
  if (cmd === "add") {
    const title = rest.join(" ").trim();
    if (!title) return { action: "invalid", usage: "Usage: /task add <title>" };
    return { action: "add", title };
  }
  if (cmd === "start" || cmd === "done" || cmd === "cancel") {
    const id = Number.parseInt(rest[0] || "", 10);
    if (!Number.isFinite(id)) {
      return { action: "invalid", usage: "Usage: /task <start|done|cancel> <id>" };
    }
    const status = cmd === "start" ? "in_progress" : cmd === "done" ? "done" : "cancelled";
    return { action: "set", id, status };
  }
  return { action: "invalid", usage: "Usage: /task [list|add|start|done|cancel|reset]" };
}

// No-op extension factory so extension discovery can load this module safely.
// The actual runtime extension is ultrawork-harness.ts.
export default function ultraworkCoreNoopExtension(_pi: ExtensionAPI): void {
  // intentionally empty
}
