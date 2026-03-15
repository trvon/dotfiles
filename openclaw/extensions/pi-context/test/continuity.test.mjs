import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRecoveryContext,
  detectContinuityIssue,
  shouldHeartbeatRefresh,
  shouldUseRecovery,
} from "../src/continuity.mjs";

test("detects terminal-status failures", () => {
  const issue = detectContinuityIssue(
    { status: "failed", error: "connector is closed" },
    "finish the report",
    "partial answer"
  );

  assert.ok(issue);
  assert.equal(issue.kind, "terminal-status");
  assert.match(issue.reason, /failed/i);
  assert.match(issue.reason, /connector is closed/i);
});

test("detects empty assistant output as silent failure", () => {
  const issue = detectContinuityIssue({ status: "ok" }, "summarize findings", "");

  assert.ok(issue);
  assert.equal(issue.kind, "empty-assistant");
  assert.match(issue.reason, /without any assistant reply/i);
});

test("allows one recovery injection within retry budget", () => {
  const session = {
    retryCount: 0,
    lastRecoveryAt: 0,
    pendingRecovery: {
      reason: "Run ended without any assistant reply text.",
      kind: "empty-assistant",
      prompt: "continue the synthesis",
      assistantText: "",
      fingerprint: "empty:test",
    },
  };
  const cfg = {
    continuityWatchdogEnabled: true,
    continuityMaxRetries: 1,
    continuityCooldownMs: 120000,
  };

  assert.equal(shouldUseRecovery(session, cfg, 1_000), true);
  session.retryCount = 1;
  assert.equal(shouldUseRecovery(session, cfg, 1_000), false);
});

test("builds recovery context with prior prompt and partial output", () => {
  const text = buildRecoveryContext({
    pendingRecovery: {
      reason: "Run ended with status \"failed\": connector is closed",
      prompt: "Investigate the Telegram delivery failure.",
      assistantText: "I found the delivery target but the final send failed.",
    },
  });

  assert.match(text, /\[Pi Continuity Watchdog\]/);
  assert.match(text, /Investigate the Telegram delivery failure/);
  assert.match(text, /delivery target/i);
});

test("heartbeat refreshes stale sessions with prior RLM context", () => {
  const session = {
    lastRlmAt: 1_000,
    lastActivityAt: 1_000,
    lastRecoveryAt: 0,
    lastQuery: "telegram delivery failure",
    lastRawPrompt: "investigate telegram delivery failure",
  };
  const cfg = {
    activityHeartbeatEnabled: true,
    activityHeartbeatMs: 1_800_000,
  };

  assert.equal(shouldHeartbeatRefresh(session, cfg, 1_801_001), true);
  assert.equal(shouldHeartbeatRefresh(session, cfg, 1_200_000), false);
});
