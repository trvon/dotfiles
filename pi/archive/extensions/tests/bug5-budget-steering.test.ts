/**
 * Bug 5 (Bonus): Budget steering injection for skipped/retry prompts.
 *
 * Tests that:
 * - Watchdog retry/cron prompts get budget steering when tokens >= CONTEXT_BUDGET_STEER_TOKENS
 * - System prompt is augmented with budget warning and YAMS-first steering
 * - Hidden message is injected when tokens >= CONTEXT_BUDGET_WARN_TOKENS
 * - No steering is injected when tokens are low
 * - Original prompt is still skipped (no full optimization)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Extract the skip-prompt budget steering logic from
// hybrid-optimizer.ts lines 2224-2252.
// ---------------------------------------------------------------------------

const CONTEXT_BUDGET_STEER_TOKENS = 80_000;
const CONTEXT_BUDGET_WARN_TOKENS = 200_000;
const YAMS_FIRST_STEERING = "IMPORTANT: Prefer YAMS search over broad directory listings.";

function shouldSkipPrompt(prompt: string): boolean {
  if (!prompt.trim()) return true;
  const prefixes = ["[health-watchdog:auto-retry]", "[health-watchdog:cron]"];
  return prefixes.some((prefix) => prompt.startsWith(prefix));
}

type ContextSteering = {
  contextWindow: number;
  usageTokens: number;
  availableTokens: number;
  usageRatio: number;
  pressure: string;
};

function buildContextSteering(
  usageTokens: number | null,
  configuredContextWindow: number,
  effectiveContextWindow: number | null
): ContextSteering | null {
  if (usageTokens === null || !Number.isFinite(usageTokens) || usageTokens < 0) return null;
  const contextWindow =
    effectiveContextWindow && Number.isFinite(effectiveContextWindow) && effectiveContextWindow > 0
      ? effectiveContextWindow
      : configuredContextWindow;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null;

  const usage = Math.max(0, Math.floor(usageTokens));
  const available = Math.max(0, Math.floor(contextWindow - usage));
  const ratio = Math.max(0, Math.min(1, usage / contextWindow));
  const pressure =
    ratio >= 0.93 ? "critical" :
    ratio >= 0.82 ? "high" :
    ratio >= 0.65 ? "medium" : "low";
  return { contextWindow, usageTokens: usage, availableTokens: available, usageRatio: ratio, pressure };
}

type SkipPromptResult = {
  skipped: boolean;
  systemPromptAugmented: boolean;
  hiddenMessageInjected: boolean;
  systemPrompt?: string;
  message?: any;
};

function evaluateSkipPromptSteering(
  prompt: string,
  systemPrompt: string,
  tokens: number | null,
  contextWindow: number,
  effectiveContextWindow: number | null,
): SkipPromptResult {
  if (!shouldSkipPrompt(prompt)) {
    return { skipped: false, systemPromptAugmented: false, hiddenMessageInjected: false };
  }

  const steering = buildContextSteering(tokens, contextWindow, effectiveContextWindow);
  if (steering && tokens !== null && tokens >= CONTEXT_BUDGET_STEER_TOKENS) {
    const budgetMsg = [
      `[CONTEXT BUDGET WARNING: ${tokens.toLocaleString()} tokens used (${Math.round(steering.usageRatio * 100)}% of ${steering.contextWindow.toLocaleString()}).`,
      YAMS_FIRST_STEERING,
      `This is a retry/recovery prompt. Keep output minimal, complete only the immediate objective, avoid broad exploration.]`,
    ].join("\n");

    const result: SkipPromptResult = {
      skipped: true,
      systemPromptAugmented: true,
      hiddenMessageInjected: false,
      systemPrompt: [systemPrompt, budgetMsg].join("\n\n"),
    };

    if (tokens >= CONTEXT_BUDGET_WARN_TOKENS) {
      result.hiddenMessageInjected = true;
      result.message = {
        customType: "hybrid-retry-budget-warning",
        content: budgetMsg,
        display: false,
      };
    }

    return result;
  }

  return { skipped: true, systemPromptAugmented: false, hiddenMessageInjected: false };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Bug 5 (Bonus): Budget steering for retry/skipped prompts", () => {

  it("identifies watchdog retry prompts as skip-worthy", () => {
    assert.equal(shouldSkipPrompt("[health-watchdog:auto-retry] continue"), true);
    assert.equal(shouldSkipPrompt("[health-watchdog:cron] check"), true);
  });

  it("does not skip normal user prompts", () => {
    assert.equal(shouldSkipPrompt("Please fix the bug"), false);
    assert.equal(shouldSkipPrompt(""), true); // empty is skipped
  });

  it("injects budget steering when tokens >= CONTEXT_BUDGET_STEER_TOKENS (80K)", () => {
    const result = evaluateSkipPromptSteering(
      "[health-watchdog:auto-retry] continue",
      "You are a helpful assistant.",
      90_000,
      262144,
      null,
    );

    assert.equal(result.skipped, true);
    assert.equal(result.systemPromptAugmented, true);
    assert.ok(result.systemPrompt!.includes("CONTEXT BUDGET WARNING"));
    assert.ok(result.systemPrompt!.includes(YAMS_FIRST_STEERING));
    assert.ok(result.systemPrompt!.includes("retry/recovery prompt"));
    assert.equal(result.hiddenMessageInjected, false,
      "Hidden message only at >= 200K tokens");
  });

  it("injects hidden message when tokens >= CONTEXT_BUDGET_WARN_TOKENS (200K)", () => {
    const result = evaluateSkipPromptSteering(
      "[health-watchdog:auto-retry] continue",
      "You are a helpful assistant.",
      210_000,
      262144,
      null,
    );

    assert.equal(result.skipped, true);
    assert.equal(result.systemPromptAugmented, true);
    assert.equal(result.hiddenMessageInjected, true);
    assert.ok(result.message);
    assert.equal(result.message.customType, "hybrid-retry-budget-warning");
    assert.equal(result.message.display, false);
  });

  it("no steering when tokens are low (< 80K)", () => {
    const result = evaluateSkipPromptSteering(
      "[health-watchdog:auto-retry] continue",
      "You are a helpful assistant.",
      40_000,
      262144,
      null,
    );

    assert.equal(result.skipped, true);
    assert.equal(result.systemPromptAugmented, false);
    assert.equal(result.hiddenMessageInjected, false);
  });

  it("no steering when tokens are null", () => {
    const result = evaluateSkipPromptSteering(
      "[health-watchdog:auto-retry] continue",
      "You are a helpful assistant.",
      null,
      262144,
      null,
    );

    assert.equal(result.skipped, true);
    assert.equal(result.systemPromptAugmented, false);
  });

  it("uses effectiveContextWindow when available", () => {
    // With a smaller effective window, 90K tokens is a higher ratio
    const result = evaluateSkipPromptSteering(
      "[health-watchdog:auto-retry] continue",
      "Base system prompt.",
      90_000,
      262144,
      120_000, // effective window much smaller
    );

    assert.equal(result.systemPromptAugmented, true);
    // 90K / 120K = 75% — should mention the correct ratio
    assert.ok(result.systemPrompt!.includes("75%") || result.systemPrompt!.includes("120,000"),
      "Should reference the effective context window");
  });

  it("normal prompt is NOT processed by skip logic", () => {
    const result = evaluateSkipPromptSteering(
      "Please fix the type error in main.ts",
      "You are a helpful assistant.",
      210_000,
      262144,
      null,
    );

    assert.equal(result.skipped, false);
    assert.equal(result.systemPromptAugmented, false);
  });

  it("cron prompts get same treatment as auto-retry prompts", () => {
    const result = evaluateSkipPromptSteering(
      "[health-watchdog:cron] periodic check",
      "You are a helpful assistant.",
      150_000,
      262144,
      null,
    );

    assert.equal(result.skipped, true);
    assert.equal(result.systemPromptAugmented, true);
    assert.ok(result.systemPrompt!.includes("CONTEXT BUDGET WARNING"));
  });

  it("budget message contains token count and percentage", () => {
    const result = evaluateSkipPromptSteering(
      "[health-watchdog:auto-retry] continue",
      "Base prompt.",
      180_000,
      262144,
      null,
    );

    assert.ok(result.systemPrompt!.includes("180,000"),
      "Should contain formatted token count");
    // 180K / 262144 ≈ 68.7%
    assert.ok(result.systemPrompt!.includes("69%") || result.systemPrompt!.includes("68%"),
      "Should contain approximate percentage");
  });
});
