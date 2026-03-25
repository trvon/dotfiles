import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  applyUltraworkAction,
  createInitialUltraworkState,
  sanitizeUltraworkState,
} from "../ultrawork-actions.ts";

describe("ultrawork-actions", () => {
  it("creates and sanitizes state deterministically", () => {
    const init = createInitialUltraworkState(true);
    assert.equal(init.modeEnabled, true);
    const restored = sanitizeUltraworkState({ modeEnabled: false, store: { nextId: 3, items: [{ id: 1, title: "a", status: "pending" }] } }, true);
    assert.equal(restored.modeEnabled, false);
    assert.equal(restored.store.items[0].status, "todo");
  });

  it("ingests tasks with dedupe and pending normalization", () => {
    let state = createInitialUltraworkState(true);
    let out = applyUltraworkAction(state, {
      action: "ingest_tasks",
      tasks: [
        { title: "Task A", status: "pending" },
        { title: "Task A", status: "done" },
        { title: "Task B", status: "in_progress" },
      ],
      dedupe: true,
    });
    assert.equal(out.ok, true);
    state = out.state;
    assert.equal(state.store.items.length, 2);
    assert.equal(state.store.items[0].status, "todo");
    assert.equal(state.store.items[1].status, "in_progress");
  });

  it("dispatches queued tasks when objective omitted", () => {
    let state = createInitialUltraworkState(true);
    state = applyUltraworkAction(state, { action: "add_task", taskTitle: "Fix warnings" }).state;
    const out = applyUltraworkAction(state, { action: "dispatch" });
    assert.equal(out.ok, true);
    assert.ok(out.dispatchObjective);
    assert.equal(out.state.runActive, true);
    assert.equal(out.state.store.items[0].status, "in_progress");
  });

  it("set_task validates id/status and handles missing task", () => {
    const state = createInitialUltraworkState(true);
    const bad = applyUltraworkAction(state, { action: "set_task", taskId: 1, taskStatus: "done" });
    assert.equal(bad.ok, false);
    assert.match(bad.text, /not found/i);
  });
});
