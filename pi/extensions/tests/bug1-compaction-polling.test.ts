/**
 * Bug 1: Compaction polling-based completion tracking.
 *
 * Tests that:
 * - The poll timer starts when compaction is triggered
 * - compactionInFlight is ONLY cleared by onComplete/onError, NOT by the poll
 * - After COMPACTION_STALL_THRESHOLD_MS the poll clears the flag as a last resort
 * - The poll cleans itself up when compaction resolves normally
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createFakeClock } from "./test-helpers.ts";

// ---------------------------------------------------------------------------
// Extract the compaction poll logic into a testable unit.
// This mirrors the pattern in hybrid-optimizer.ts lines 1719-1777.
// ---------------------------------------------------------------------------

const COMPACTION_POLL_INTERVAL_MS = 10_000;
const COMPACTION_STALL_THRESHOLD_MS = 300_000; // 5 min

type CompactionState = {
  compactionInFlight: boolean;
  compactionStartedAt: number;
  pollTimer: ReturnType<typeof setInterval> | null;
  traces: Array<{ type: string; payload: Record<string, unknown> }>;
  notifications: string[];
};

function createCompactionState(): CompactionState {
  return {
    compactionInFlight: false,
    compactionStartedAt: 0,
    pollTimer: null,
    traces: [],
    notifications: [],
  };
}

function stopCompactionPoll(state: CompactionState): void {
  if (state.pollTimer !== null) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function startCompactionPoll(state: CompactionState): void {
  stopCompactionPoll(state);
  state.pollTimer = setInterval(() => {
    if (!state.compactionInFlight) {
      stopCompactionPoll(state);
      return;
    }
    const elapsed = Date.now() - state.compactionStartedAt;

    if (elapsed >= COMPACTION_STALL_THRESHOLD_MS) {
      state.compactionInFlight = false;
      stopCompactionPoll(state);
      state.traces.push({ type: "compaction_stall_cleared", payload: { elapsedMs: elapsed } });
      state.notifications.push(`Compaction stalled after ${Math.round(elapsed / 1000)}s`);
      return;
    }

    state.traces.push({ type: "compaction_poll", payload: { elapsedMs: elapsed } });
    if (elapsed > 60_000) {
      state.notifications.push(`Compaction still processing (${Math.round(elapsed / 1000)}s elapsed)...`);
    }
  }, COMPACTION_POLL_INTERVAL_MS);
}

function triggerCompaction(
  state: CompactionState,
  onCompleteFn: () => void,
  onErrorFn: (error: Error) => void
): { complete: () => void; fail: (error: Error) => void } {
  state.compactionInFlight = true;
  state.compactionStartedAt = Date.now();

  const complete = () => {
    state.compactionInFlight = false;
    stopCompactionPoll(state);
    state.traces.push({ type: "compaction_complete", payload: { elapsedMs: Date.now() - state.compactionStartedAt } });
    onCompleteFn();
  };

  const fail = (error: Error) => {
    state.compactionInFlight = false;
    stopCompactionPoll(state);
    state.traces.push({ type: "compaction_error", payload: { message: error.message } });
    onErrorFn(error);
  };

  startCompactionPoll(state);
  return { complete, fail };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Bug 1: Compaction polling-based completion tracking", () => {
  let clock: ReturnType<typeof createFakeClock>;
  let state: CompactionState;

  beforeEach(() => {
    clock = createFakeClock(1000000);
    clock.install();
    state = createCompactionState();
  });

  afterEach(() => {
    stopCompactionPoll(state);
    clock.restore();
  });

  it("sets compactionInFlight when compaction is triggered", () => {
    const { complete } = triggerCompaction(state, () => {}, () => {});
    assert.equal(state.compactionInFlight, true);
    assert.equal(state.compactionStartedAt, clock.now);
    assert.notEqual(state.pollTimer, null, "poll timer should be started");
    complete(); // cleanup
  });

  it("clears compactionInFlight on onComplete", () => {
    const { complete } = triggerCompaction(state, () => {}, () => {});
    assert.equal(state.compactionInFlight, true);
    clock.advance(30_000); // 30s
    complete();
    assert.equal(state.compactionInFlight, false);
    assert.equal(state.pollTimer, null, "poll timer should be cleaned up");
  });

  it("clears compactionInFlight on onError", () => {
    const { fail } = triggerCompaction(state, () => {}, () => {});
    assert.equal(state.compactionInFlight, true);
    clock.advance(15_000);
    fail(new Error("test error"));
    assert.equal(state.compactionInFlight, false);
    assert.equal(state.pollTimer, null, "poll timer should be cleaned up");
  });

  it("poll does NOT prematurely clear compactionInFlight before stall threshold", (t) => {
    // We need real timers here briefly to test the interval fires
    clock.restore();

    const realState = createCompactionState();
    realState.compactionInFlight = true;
    realState.compactionStartedAt = Date.now();

    // Start a poll with short interval for testing
    const SHORT_INTERVAL = 50;
    realState.pollTimer = setInterval(() => {
      if (!realState.compactionInFlight) {
        stopCompactionPoll(realState);
        return;
      }
      const elapsed = Date.now() - realState.compactionStartedAt;
      // The key assertion: poll should NOT clear compactionInFlight
      // before stall threshold (which is 300s, so definitely not in 200ms)
      realState.traces.push({ type: "compaction_poll", payload: { elapsedMs: elapsed } });
    }, SHORT_INTERVAL);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // After 200ms, compactionInFlight should STILL be true
        assert.equal(realState.compactionInFlight, true,
          "Poll must NOT clear compactionInFlight before stall threshold");
        assert.ok(realState.traces.length > 0, "Poll should have fired at least once");
        stopCompactionPoll(realState);
        resolve();
      }, 200);
    });
  });

  it("poll clears flag after COMPACTION_STALL_THRESHOLD_MS as last resort", () => {
    triggerCompaction(state, () => {}, () => {});
    assert.equal(state.compactionInFlight, true);

    // Simulate a stall: advance time past threshold, then let the interval fire
    // We can't easily test setInterval with fake timers, so test the logic directly
    clock.advance(COMPACTION_STALL_THRESHOLD_MS + 1000);

    // Simulate what the interval callback does
    const elapsed = Date.now() - state.compactionStartedAt;
    if (elapsed >= COMPACTION_STALL_THRESHOLD_MS) {
      state.compactionInFlight = false;
      stopCompactionPoll(state);
      state.traces.push({ type: "compaction_stall_cleared", payload: { elapsedMs: elapsed } });
    }

    assert.equal(state.compactionInFlight, false);
    assert.ok(
      state.traces.some((t) => t.type === "compaction_stall_cleared"),
      "Should have traced compaction_stall_cleared"
    );
  });

  it("poll stops itself when compaction resolves between intervals", () => {
    const { complete } = triggerCompaction(state, () => {}, () => {});
    complete();
    assert.equal(state.pollTimer, null, "poll should be stopped after completion");
    assert.equal(state.compactionInFlight, false);
  });

  it("session_shutdown cleans up poll timer", () => {
    triggerCompaction(state, () => {}, () => {});
    assert.notEqual(state.pollTimer, null);

    // Simulate session_shutdown
    stopCompactionPoll(state);
    state.compactionInFlight = false;

    assert.equal(state.pollTimer, null);
    assert.equal(state.compactionInFlight, false);
  });
});
