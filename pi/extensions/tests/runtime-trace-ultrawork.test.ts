import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { analyzeUltraworkTrace } from "../runtime-trace.ts";

describe("runtime-trace ultrawork analyzer", () => {
  it("reports running state and counters", () => {
    const now = Date.now();
    const mk = (type: string, deltaMs: number) => ({ type, ts: new Date(now - deltaMs).toISOString() });
    const events = [
      mk("session_start", 5000),
      mk("task_add", 4000),
      mk("ultrawork_dispatch", 3000),
      mk("ultrawork_run_started", 2000),
    ];
    const out = analyzeUltraworkTrace(events, now, 10_000);
    assert.equal(out.runActive, true);
    assert.equal(out.dispatches.recent, 1);
    assert.equal(out.taskAdds.recent, 1);
    assert.equal(out.runsStarted.recent, 1);
    assert.equal(out.runsFinished.recent, 0);
  });

  it("clears running state after run_finished", () => {
    const now = Date.now();
    const mk = (type: string, deltaMs: number) => ({ type, ts: new Date(now - deltaMs).toISOString() });
    const events = [
      mk("ultrawork_run_started", 3000),
      mk("task_update", 2000),
      mk("ultrawork_run_finished", 1000),
    ];
    const out = analyzeUltraworkTrace(events, now, 10_000);
    assert.equal(out.runActive, false);
    assert.equal(out.taskUpdates.recent, 1);
    assert.equal(out.runsFinished.recent, 1);
  });
});
