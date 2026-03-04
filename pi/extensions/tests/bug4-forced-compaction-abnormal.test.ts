/**
 * Bug 4: Forced compaction on abnormal stops with critical context.
 *
 * Tests that:
 * - Abnormal stops (terminated, aborted, etc.) with context >= 80% trigger compaction
 * - Abnormal stops with context < 80% skip compaction (existing behavior)
 * - Normal stops proceed to the standard compaction threshold check
 * - The CRITICAL_CONTEXT_RATIO (0.80) threshold is correct
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Extract the abnormal stop + critical context logic from
// hybrid-optimizer.ts lines 2701-2735.
// ---------------------------------------------------------------------------

const CRITICAL_CONTEXT_RATIO = 0.80;

type CompactionDecision =
  | { action: "skip"; reason: string }
  | { action: "force_compaction"; reason: string; usageRatio: number }
  | { action: "continue_to_threshold_check" };

function evaluateAbnormalStop(
  stopReason: string | undefined,
  tokens: number | null,
  contextWindow: number,
): CompactionDecision {
  if (typeof stopReason === "string") {
    const lower = stopReason.trim().toLowerCase();
    const abnormal = ["terminated", "abort", "aborted", "cancel", "cancelled", "interrupted", "error"];
    if (abnormal.some((token) => lower.includes(token))) {
      const usageRatio = tokens !== null ? tokens / contextWindow : 0;
      if (usageRatio < CRITICAL_CONTEXT_RATIO) {
        return { action: "skip", reason: `abnormal_stop:${stopReason}` };
      }
      return {
        action: "force_compaction",
        reason: "critical_context_on_abnormal_stop",
        usageRatio,
      };
    }
  }
  return { action: "continue_to_threshold_check" };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Bug 4: Forced compaction on abnormal stops with critical context", () => {

  it("forces compaction when stop is 'terminated' and context >= 80%", () => {
    const result = evaluateAbnormalStop("terminated", 220000, 262144);
    assert.equal(result.action, "force_compaction");
    assert.ok("usageRatio" in result && result.usageRatio >= CRITICAL_CONTEXT_RATIO);
  });

  it("forces compaction when stop is 'aborted' and context >= 80%", () => {
    const result = evaluateAbnormalStop("aborted", 210000, 262144);
    assert.equal(result.action, "force_compaction");
  });

  it("forces compaction when stop is 'error' and context >= 80%", () => {
    const result = evaluateAbnormalStop("error", 210000, 262144);
    assert.equal(result.action, "force_compaction");
  });

  it("skips compaction when stop is 'terminated' but context < 80%", () => {
    const result = evaluateAbnormalStop("terminated", 100000, 262144);
    assert.equal(result.action, "skip");
  });

  it("skips compaction when stop is 'aborted' and context is low", () => {
    const result = evaluateAbnormalStop("aborted", 50000, 262144);
    assert.equal(result.action, "skip");
  });

  it("continues to threshold check on normal stop (end_turn)", () => {
    const result = evaluateAbnormalStop("end_turn", 220000, 262144);
    assert.equal(result.action, "continue_to_threshold_check");
  });

  it("continues to threshold check when stopReason is undefined", () => {
    const result = evaluateAbnormalStop(undefined, 220000, 262144);
    assert.equal(result.action, "continue_to_threshold_check");
  });

  it("handles null tokens by treating usage ratio as 0 (skip)", () => {
    const result = evaluateAbnormalStop("terminated", null, 262144);
    assert.equal(result.action, "skip",
      "null tokens should result in usageRatio=0, which is < 0.80");
  });

  it("boundary: exactly at 80% triggers force_compaction", () => {
    // Use a token count that produces exactly 0.80 ratio (or just above)
    // Math.floor(262144 * 0.80) = 209715, but 209715/262144 = 0.79999...
    // So we need 209716 to get >= 0.80
    const tokens = Math.ceil(262144 * 0.80);
    const result = evaluateAbnormalStop("aborted", tokens, 262144);
    assert.equal(result.action, "force_compaction");
  });

  it("boundary: just below 80% skips compaction", () => {
    const tokens = Math.floor(262144 * 0.80) - 1;
    const result = evaluateAbnormalStop("aborted", tokens, 262144);
    assert.equal(result.action, "skip");
  });

  it("recognizes all abnormal stop variants", () => {
    const abnormalReasons = [
      "terminated", "abort", "aborted", "cancel", "cancelled",
      "interrupted", "error", "Model error", "operation aborted",
    ];
    for (const reason of abnormalReasons) {
      const result = evaluateAbnormalStop(reason, 220000, 262144);
      assert.notEqual(result.action, "continue_to_threshold_check",
        `'${reason}' should be recognized as abnormal`);
    }
  });

  it("normal stop reasons pass through to threshold check", () => {
    const normalReasons = ["end_turn", "max_tokens", "stop", "length", "complete"];
    for (const reason of normalReasons) {
      const result = evaluateAbnormalStop(reason, 220000, 262144);
      assert.equal(result.action, "continue_to_threshold_check",
        `'${reason}' should NOT be treated as abnormal`);
    }
  });

  it("works with different context window sizes", () => {
    // 128K window
    const result128 = evaluateAbnormalStop("terminated", 104000, 128000);
    assert.equal(result128.action, "force_compaction",
      "104K/128K = 81.25% should force compaction");

    // 4096 window (warm-up bug scenario)
    const result4k = evaluateAbnormalStop("terminated", 3500, 4096);
    assert.equal(result4k.action, "force_compaction",
      "3500/4096 = 85.4% should force compaction");
  });
});
