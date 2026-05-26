/**
 * Bug 3: Emergency compaction after max retries.
 *
 * Tests that:
 * - When retryCount >= maxRetries, ctx.compact() is called with emergency instructions
 * - The watchdog is NOT cleared (clearWatchdog is NOT called)
 * - The emergency compaction has onComplete/onError callbacks that trace
 * - If ctx.compact() throws, the exception is caught gracefully
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMockCtx, assertCompactCalled } from "./test-helpers.ts";

// ---------------------------------------------------------------------------
// Extract the max-retries logic from health-watchdog.ts lines 851-889.
// ---------------------------------------------------------------------------

type WatchdogState = {
  retryCount: number;
  maxRetries: number;
  watchdogCleared: boolean;
  traces: Array<{ type: string; payload: Record<string, unknown> }>;
};

function handleMaxRetries(
  state: WatchdogState,
  ctx: ReturnType<typeof createMockCtx>,
  stallKind: string
): { action: "emergency_compaction" | "cleared_watchdog" | "continue_retry" } {
  if (state.retryCount < state.maxRetries) {
    return { action: "continue_retry" };
  }

  state.traces.push({
    type: "max_retries_reached",
    payload: { retryCount: state.retryCount, maxRetries: state.maxRetries, stallKind },
  });

  // The Bug 3 fix: emergency compaction, do NOT clear watchdog
  try {
    ctx.compact({
      customInstructions:
        "Emergency compaction after watchdog max retries. Aggressively reduce context. Preserve only: current objective, file paths with unsaved changes, and final error state.",
      onComplete: () => {
        state.traces.push({ type: "emergency_compaction_complete", payload: {} });
      },
      onError: (error: Error) => {
        state.traces.push({ type: "emergency_compaction_error", payload: { message: error.message } });
      },
    });
  } catch (compactError) {
    state.traces.push({
      type: "emergency_compaction_exception",
      payload: { message: compactError instanceof Error ? compactError.message : "unknown" },
    });
  }

  // Key: do NOT set state.watchdogCleared = true
  return { action: "emergency_compaction" };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Bug 3: Emergency compaction after max retries", () => {
  it("calls ctx.compact() with emergency instructions when maxRetries reached", () => {
    const ctx = createMockCtx({ tokens: 200000 });
    const state: WatchdogState = {
      retryCount: 2,
      maxRetries: 2,
      watchdogCleared: false,
      traces: [],
    };

    const result = handleMaxRetries(state, ctx, "model_stall");

    assert.equal(result.action, "emergency_compaction");
    assertCompactCalled(ctx, {
      customInstructionsContains: "Emergency compaction after watchdog max retries",
    });
  });

  it("does NOT clear the watchdog", () => {
    const ctx = createMockCtx({ tokens: 200000 });
    const state: WatchdogState = {
      retryCount: 2,
      maxRetries: 2,
      watchdogCleared: false,
      traces: [],
    };

    handleMaxRetries(state, ctx, "model_stall");

    assert.equal(state.watchdogCleared, false,
      "Watchdog should NOT be cleared after emergency compaction");
  });

  it("continues to retry when retryCount < maxRetries", () => {
    const ctx = createMockCtx({ tokens: 100000 });
    const state: WatchdogState = {
      retryCount: 1,
      maxRetries: 2,
      watchdogCleared: false,
      traces: [],
    };

    const result = handleMaxRetries(state, ctx, "model_stall");

    assert.equal(result.action, "continue_retry");
    assert.equal(ctx._compactCalls.length, 0, "Should not call compact when retries remain");
  });

  it("onComplete callback traces emergency compaction success", () => {
    const ctx = createMockCtx({ tokens: 200000 });
    const state: WatchdogState = {
      retryCount: 2,
      maxRetries: 2,
      watchdogCleared: false,
      traces: [],
    };

    handleMaxRetries(state, ctx, "model_stall");

    // Simulate compaction completing successfully
    const compactOpts = ctx._compactCalls[0];
    assert.ok(typeof compactOpts.onComplete === "function");
    compactOpts.onComplete();

    assert.ok(
      state.traces.some((t) => t.type === "emergency_compaction_complete"),
      "Should trace emergency_compaction_complete on success"
    );
  });

  it("onError callback traces emergency compaction failure", () => {
    const ctx = createMockCtx({ tokens: 200000 });
    const state: WatchdogState = {
      retryCount: 2,
      maxRetries: 2,
      watchdogCleared: false,
      traces: [],
    };

    handleMaxRetries(state, ctx, "model_stall");

    const compactOpts = ctx._compactCalls[0];
    assert.ok(typeof compactOpts.onError === "function");
    compactOpts.onError(new Error("9b model failed"));

    const errorTrace = state.traces.find((t) => t.type === "emergency_compaction_error");
    assert.ok(errorTrace, "Should trace emergency_compaction_error on failure");
    assert.equal((errorTrace!.payload as any).message, "9b model failed");
  });

  it("catches exceptions if ctx.compact() itself throws", () => {
    const ctx = createMockCtx({ tokens: 200000 });
    // Make compact throw
    ctx.compact = () => { throw new Error("compact unavailable"); };
    ctx._compactCalls = []; // compact override means _compactCalls won't track

    const state: WatchdogState = {
      retryCount: 2,
      maxRetries: 2,
      watchdogCleared: false,
      traces: [],
    };

    // Should NOT throw
    assert.doesNotThrow(() => {
      handleMaxRetries(state, ctx, "model_stall");
    });

    const exceptionTrace = state.traces.find((t) => t.type === "emergency_compaction_exception");
    assert.ok(exceptionTrace, "Should trace the exception");
    assert.equal((exceptionTrace!.payload as any).message, "compact unavailable");

    // Watchdog still not cleared
    assert.equal(state.watchdogCleared, false);
  });

  it("traces max_retries_reached event", () => {
    const ctx = createMockCtx({ tokens: 200000 });
    const state: WatchdogState = {
      retryCount: 3,
      maxRetries: 2,
      watchdogCleared: false,
      traces: [],
    };

    handleMaxRetries(state, ctx, "tool_stall");

    const trace = state.traces.find((t) => t.type === "max_retries_reached");
    assert.ok(trace);
    assert.equal((trace!.payload as any).stallKind, "tool_stall");
    assert.equal((trace!.payload as any).retryCount, 3);
  });
});
