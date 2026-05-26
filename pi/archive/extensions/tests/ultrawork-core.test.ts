import { describe, it } from "node:test";
import assert from "node:assert/strict";

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
} from "../ultrawork-core.ts";

describe("ultrawork-core", () => {
  it("normalizes prompt and strips system reminder blocks", () => {
    const raw = "hello <system-reminder>internal</system-reminder> world";
    assert.equal(normalizePrompt(raw), "hello world");
  });

  it("parses task commands", () => {
    assert.deepEqual(parseTaskCommand(""), { action: "list" });
    assert.deepEqual(parseTaskCommand("list"), { action: "list" });
    assert.deepEqual(parseTaskCommand("reset"), { action: "reset" });
    assert.deepEqual(parseTaskCommand("add implement tests"), { action: "add", title: "implement tests" });
    assert.deepEqual(parseTaskCommand("start 3"), { action: "set", id: 3, status: "in_progress" });
    assert.deepEqual(parseTaskCommand("done 4"), { action: "set", id: 4, status: "done" });
    assert.deepEqual(parseTaskCommand("cancel 5"), { action: "set", id: 5, status: "cancelled" });
    assert.equal(parseTaskCommand("add").action, "invalid");
    assert.equal(parseTaskCommand("start x").action, "invalid");
  });

  it("adds and updates task state", () => {
    const store = makeEmptyStore();
    const t1 = addTask(store, "ship feature", 1000);
    assert.equal(t1.id, 1);
    assert.equal(store.nextId, 2);
    const updated = setTaskStatus(store, 1, "in_progress", 1200);
    assert.ok(updated);
    assert.equal(updated?.status, "in_progress");
    assert.equal(updated?.updatedAt, 1200);
    assert.equal(setTaskStatus(store, 99, "done"), null);
  });

  it("sanitizes malformed store payloads", () => {
    const now = 2000;
    const store = sanitizeStore(
      {
        nextId: "bad",
        items: [
          { id: 1, title: "ok", status: "weird" },
          { id: "x", title: "bad" },
        ],
      },
      now
    );
    assert.equal(store.items.length, 1);
    assert.equal(store.items[0].status, "todo");
    assert.equal(store.nextId, 2);
  });

  it("maps pending->todo and builds objective from queued tasks", () => {
    const store = sanitizeStore(
      {
        nextId: 3,
        items: [
          { id: 1, title: "task one", status: "pending" },
          { id: 2, title: "task two", status: "done" },
        ],
      },
      3000
    );
    const dispatchable = getDispatchableTasks(store);
    assert.equal(dispatchable.length, 1);
    assert.equal(dispatchable[0].status, "todo");
    const objective = buildObjectiveFromTasks(store);
    assert.ok(objective);
    assert.match(objective || "", /\[#1\] task one/);
  });

  it("formats a stable ultrawork prompt and task list", () => {
    const prompt = buildUltraworkPrompt("fix compiler warnings");
    assert.match(prompt, /\[ultrawork\]/);
    assert.match(prompt, /parallel orchestration/i);
    const store = makeEmptyStore();
    addTask(store, "fix warnings", 1);
    const rendered = formatTaskList(store);
    assert.match(rendered, /#1 \[todo\] fix warnings/);
  });
});
