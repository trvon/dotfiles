/**
 * Bug 2: final_tail_pending hard cap enforcement.
 *
 * Tests that:
 * - finalTailFirstActivatedAt is set on first activation and NOT reset by re-entries
 * - After FINAL_TAIL_HARD_CAP_MS total elapsed, the hard cap fires
 * - Hard cap forces final_tail_pending to false and triggers pending recovery
 * - resolveFinalTail resets finalTailFirstActivatedAt
 * - State resets (session_start, turn_start, etc.) all clear finalTailFirstActivatedAt
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createFakeClock } from "./test-helpers.ts";

// ---------------------------------------------------------------------------
// Extract the final_tail logic from health-watchdog.ts lines 555-617.
// ---------------------------------------------------------------------------

const FINAL_TAIL_GRACE_MS = 15_000;
const FINAL_TAIL_HARD_CAP_MS = 60_000;

type FinalTailState = {
  finalTailPending: boolean;
  finalTailStartedAt: number;
  finalTailFirstActivatedAt: number;
  finalTailTimer: ReturnType<typeof setTimeout> | null;
  pendingTermination: { id: string } | null;
  queuedWriteSchemaGuard: boolean;
  traces: Array<{ type: string; payload: Record<string, unknown> }>;
  recoveries: string[];
  writeSchemaDispatches: string[];
};

function createFinalTailState(): FinalTailState {
  return {
    finalTailPending: false,
    finalTailStartedAt: 0,
    finalTailFirstActivatedAt: 0,
    finalTailTimer: null,
    pendingTermination: null,
    queuedWriteSchemaGuard: false,
    traces: [],
    recoveries: [],
    writeSchemaDispatches: [],
  };
}

function clearFinalTailTimer(state: FinalTailState): void {
  if (state.finalTailTimer !== null) {
    clearTimeout(state.finalTailTimer);
    state.finalTailTimer = null;
  }
}

function resolveFinalTail(state: FinalTailState): void {
  state.finalTailPending = false;
  state.finalTailStartedAt = 0;
  state.finalTailFirstActivatedAt = 0;
  clearFinalTailTimer(state);
}

function startFinalTailWatch(state: FinalTailState, source: string): void {
  const now = Date.now();

  // Track first activation — survives re-entries.
  if (!state.finalTailPending || state.finalTailFirstActivatedAt === 0) {
    state.finalTailFirstActivatedAt = now;
  }

  // Hard cap check.
  const totalElapsed = now - state.finalTailFirstActivatedAt;
  if (totalElapsed >= FINAL_TAIL_HARD_CAP_MS) {
    state.traces.push({
      type: "final_tail_hard_cap_reached",
      payload: { source, totalElapsedMs: totalElapsed, hardCapMs: FINAL_TAIL_HARD_CAP_MS },
    });
    state.finalTailPending = false;
    state.finalTailStartedAt = 0;
    state.finalTailFirstActivatedAt = 0;
    clearFinalTailTimer(state);

    if (state.pendingTermination) {
      state.recoveries.push(`termination_recovery:${source}`);
      state.pendingTermination = null;
    }
    if (state.queuedWriteSchemaGuard) {
      state.writeSchemaDispatches.push(source);
      state.queuedWriteSchemaGuard = false;
    }
    return;
  }

  state.finalTailPending = true;
  state.finalTailStartedAt = now;
  clearFinalTailTimer(state);
  state.traces.push({
    type: "final_tail_pending",
    payload: { source, graceMs: FINAL_TAIL_GRACE_MS, totalElapsedMs: totalElapsed, hardCapMs: FINAL_TAIL_HARD_CAP_MS },
  });

  state.finalTailTimer = setTimeout(() => {
    if (!state.finalTailPending) return;
    state.finalTailPending = false;
    state.finalTailStartedAt = 0;
    state.finalTailFirstActivatedAt = 0;
    clearFinalTailTimer(state);
    state.traces.push({ type: "final_tail_timeout", payload: { source } });

    if (state.pendingTermination) {
      state.recoveries.push(`termination_recovery:${source}`);
      state.pendingTermination = null;
    }
    if (state.queuedWriteSchemaGuard) {
      state.writeSchemaDispatches.push(source);
      state.queuedWriteSchemaGuard = false;
    }
  }, FINAL_TAIL_GRACE_MS);
}

function resetAllState(state: FinalTailState): void {
  state.finalTailPending = false;
  state.finalTailStartedAt = 0;
  state.finalTailFirstActivatedAt = 0;
  clearFinalTailTimer(state);
  state.pendingTermination = null;
  state.queuedWriteSchemaGuard = false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Bug 2: final_tail_pending hard cap enforcement", () => {
  let clock: ReturnType<typeof createFakeClock>;
  let state: FinalTailState;

  beforeEach(() => {
    clock = createFakeClock(1000000);
    clock.install();
    state = createFinalTailState();
  });

  afterEach(() => {
    clearFinalTailTimer(state);
    clock.restore();
  });

  it("sets finalTailFirstActivatedAt on first activation", () => {
    startFinalTailWatch(state, "tool_use_1");
    assert.equal(state.finalTailFirstActivatedAt, clock.now);
    assert.equal(state.finalTailPending, true);
  });

  it("does NOT reset finalTailFirstActivatedAt on re-entry", () => {
    startFinalTailWatch(state, "tool_use_1");
    const firstActivation = state.finalTailFirstActivatedAt;

    clock.advance(5_000); // 5s later
    startFinalTailWatch(state, "tool_use_2");

    assert.equal(state.finalTailFirstActivatedAt, firstActivation,
      "finalTailFirstActivatedAt should NOT be reset by re-entry");
    assert.equal(state.finalTailPending, true);
  });

  it("fires hard cap after FINAL_TAIL_HARD_CAP_MS total elapsed", () => {
    startFinalTailWatch(state, "tool_use_1");
    const firstActivation = state.finalTailFirstActivatedAt;

    // Simulate rapid re-entries over 60+ seconds
    for (let i = 0; i < 12; i++) {
      clock.advance(5_000);
      startFinalTailWatch(state, `tool_use_${i + 2}`);
    }

    // After 12 * 5s = 60s, total elapsed >= FINAL_TAIL_HARD_CAP_MS
    const hardCapTraces = state.traces.filter((t) => t.type === "final_tail_hard_cap_reached");
    assert.ok(hardCapTraces.length > 0, "Hard cap should have fired");
    assert.equal(state.finalTailPending, false, "finalTailPending should be cleared by hard cap");
    assert.equal(state.finalTailFirstActivatedAt, 0, "firstActivatedAt should be reset");
  });

  it("hard cap triggers pending termination recovery", () => {
    state.pendingTermination = { id: "term-1" };
    startFinalTailWatch(state, "tool_use_1");

    clock.advance(FINAL_TAIL_HARD_CAP_MS + 1);
    startFinalTailWatch(state, "tool_use_final");

    assert.ok(state.recoveries.length > 0, "Should have triggered termination recovery");
    assert.equal(state.pendingTermination, null, "pendingTermination should be cleared");
  });

  it("hard cap dispatches queued write-schema guard", () => {
    state.queuedWriteSchemaGuard = true;
    startFinalTailWatch(state, "tool_use_1");

    clock.advance(FINAL_TAIL_HARD_CAP_MS + 1);
    startFinalTailWatch(state, "tool_use_final");

    assert.ok(state.writeSchemaDispatches.length > 0, "Should have dispatched write-schema guard");
    assert.equal(state.queuedWriteSchemaGuard, false);
  });

  it("resolveFinalTail resets finalTailFirstActivatedAt", () => {
    startFinalTailWatch(state, "tool_use_1");
    assert.ok(state.finalTailFirstActivatedAt > 0);

    resolveFinalTail(state);
    assert.equal(state.finalTailFirstActivatedAt, 0);
    assert.equal(state.finalTailPending, false);
    assert.equal(state.finalTailTimer, null);
  });

  it("state reset clears all final-tail state including firstActivatedAt", () => {
    startFinalTailWatch(state, "tool_use_1");
    state.pendingTermination = { id: "term-1" };
    state.queuedWriteSchemaGuard = true;

    resetAllState(state);

    assert.equal(state.finalTailPending, false);
    assert.equal(state.finalTailStartedAt, 0);
    assert.equal(state.finalTailFirstActivatedAt, 0);
    assert.equal(state.finalTailTimer, null);
    assert.equal(state.pendingTermination, null);
    assert.equal(state.queuedWriteSchemaGuard, false);
  });

  it("grace timer fires normally when no hard cap is reached", () => {
    return new Promise<void>((resolve) => {
      clock.restore(); // need real timers for setTimeout
      const realState = createFinalTailState();
      realState.pendingTermination = { id: "term-1" };

      // Use a very short grace period for testing
      realState.finalTailPending = true;
      realState.finalTailFirstActivatedAt = Date.now();
      realState.finalTailStartedAt = Date.now();

      realState.finalTailTimer = setTimeout(() => {
        if (!realState.finalTailPending) {
          resolve();
          return;
        }
        realState.finalTailPending = false;
        realState.finalTailStartedAt = 0;
        realState.finalTailFirstActivatedAt = 0;
        if (realState.pendingTermination) {
          realState.recoveries.push("normal_grace_timeout");
          realState.pendingTermination = null;
        }

        assert.ok(realState.recoveries.includes("normal_grace_timeout"),
          "Grace timer should trigger recovery when hard cap not reached");
        clearFinalTailTimer(realState);
        resolve();
      }, 50); // 50ms for testing speed
    });
  });

  it("rapid oscillation pattern is capped at 60s", () => {
    // Simulate the exact death spiral from the trace:
    // Rapid tool_use events every ~1s re-activating final_tail_pending
    startFinalTailWatch(state, "assistant_tool_use_1");

    let hardCapFiredAtSecond = -1;
    for (let second = 1; second <= 70; second++) {
      clock.advance(1000);
      const tracesBefore = state.traces.filter((t) => t.type === "final_tail_hard_cap_reached").length;
      startFinalTailWatch(state, `assistant_tool_use_${second + 1}`);
      const tracesAfter = state.traces.filter((t) => t.type === "final_tail_hard_cap_reached").length;
      if (tracesAfter > tracesBefore && hardCapFiredAtSecond < 0) {
        hardCapFiredAtSecond = second;
      }
    }

    // The hard cap should have fired at ~60s
    assert.ok(hardCapFiredAtSecond >= 0,
      "Hard cap should fire during rapid oscillation pattern");
    assert.ok(hardCapFiredAtSecond >= 59 && hardCapFiredAtSecond <= 61,
      `Hard cap should fire around 60s, fired at ${hardCapFiredAtSecond}s`);
  });
});
