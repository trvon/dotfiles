#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const hybridExtension = path.resolve(root, "extensions/hybrid-optimizer.ts");
const watchdogExtension = path.resolve(root, "extensions/health-watchdog.ts");
const researchExtension = path.resolve(root, "extensions/research-orchestrator.ts");
const runtimeTraceExtension = path.resolve(root, "extensions/runtime-trace.ts");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runPi(prompt, extensionPath, extraEnv, timeoutMs = 300000) {
  const args = [
    "--no-session",
    "--no-extensions",
    "--extension",
    extensionPath,
    "--provider",
    "lmstudio",
    "--model",
    "unsloth/qwen3.5-35b-a3b",
    "--mode",
    "json",
    "-p",
    prompt,
  ];

  const result = spawnSync("pi", args, {
    env: { ...process.env, ...extraEnv },
    encoding: "utf-8",
    timeout: timeoutMs,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`pi failed for prompt '${prompt}': ${result.stderr || result.stdout}`);
  }
}

function readJsonl(filePath) {
  assert(fs.existsSync(filePath), `trace file missing: ${filePath}`);
  const lines = fs
    .readFileSync(filePath, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.map((line) => JSON.parse(line));
}

function hasType(events, type) {
  return events.some((event) => event.type === type);
}

function findEvent(events, type) {
  return events.find((event) => event.type === type);
}

function findEvents(events, type) {
  return events.filter((event) => event.type === type);
}

function runHybridSmoke(traceDir) {
  const traceFile = path.join(traceDir, "hybrid-trace.jsonl");
  const expectedOptimizerModel = "unsloth/qwen3.5-35b-a3b";
  runPi("/hybrid-proof", hybridExtension, {
    PI_HYBRID_TRACE_FILE: traceFile,
    PI_HYBRID_YAMS_ENABLED: "0",
    PI_OPTIMIZER_MIN_CHARS: "1",
    PI_OPTIMIZER_MODEL: expectedOptimizerModel,
  });

  const events = readJsonl(traceFile);
  assert(hasType(events, "optimizer_attempt"), "hybrid: missing optimizer_attempt event");
  assert(hasType(events, "optimizer_model_call"), "hybrid: missing optimizer_model_call event");
  const modelCallEvent = findEvent(events, "optimizer_model_call");
  assert(
    modelCallEvent && modelCallEvent.modelId === expectedOptimizerModel,
    `hybrid: expected optimizer modelId='${expectedOptimizerModel}'`
  );
  assert(
    modelCallEvent && typeof modelCallEvent.contextPressure === "string",
    "hybrid: expected contextPressure on optimizer_model_call"
  );
  assert(
    hasType(events, "optimizer_success") || hasType(events, "optimizer_fallback"),
    "hybrid: missing optimizer_success/optimizer_fallback event"
  );
}

function runHybridFlowSmoke(traceDir) {
  const traceFile = path.join(traceDir, "hybrid-flow-trace.jsonl");
  runPi("/hybrid-proof-forward", hybridExtension, {
    PI_HYBRID_TRACE_FILE: traceFile,
    PI_HYBRID_YAMS_ENABLED: "0",
    PI_HYBRID_ALLOW_LOOSE_PARSE: "0",
    PI_HYBRID_FORWARD_OPTIMIZED_MESSAGE: "1",
  });

  const events = readJsonl(traceFile);
  assert(hasType(events, "session_start"), "hybrid flow: missing session_start event");
  assert(hasType(events, "optimizer_forwarded_prompt"), "hybrid flow: missing optimizer_forwarded_prompt event");
  assert(!hasType(events, "optimizer_model_loose_parsed"), "hybrid flow: loose parsing should be disabled by default");
}

function runOracleSmoke(traceDir) {
  const traceFile = path.join(traceDir, "oracle-trace.jsonl");
  runPi("/oracle-proof", hybridExtension, {
    PI_HYBRID_TRACE_FILE: traceFile,
    PI_HYBRID_YAMS_ENABLED: "0",
    PI_ORACLE_MODEL: "unsloth/qwen3.5-35b-a3b",
  });

  const events = readJsonl(traceFile);
  assert(hasType(events, "oracle_attempt"), "oracle: missing oracle_attempt event");
  assert(
    hasType(events, "oracle_success") || hasType(events, "oracle_parse_failed") || hasType(events, "oracle_error"),
    "oracle: missing oracle_success/oracle_parse_failed/oracle_error event"
  );
}

function runWatchdogSmoke(traceDir) {
  const traceFile = path.join(traceDir, "watchdog-trace.jsonl");
  const expectedVerifierModel = "qwen3.5-9b";
  runPi("/watchdog-proof", watchdogExtension, {
    PI_HEALTH_WATCHDOG_TRACE_FILE: traceFile,
    PI_HEALTH_WATCHDOG_VERIFY_BEFORE_RETRY: "1",
    PI_HEALTH_WATCHDOG_VERIFIER_MODEL: expectedVerifierModel,
    PI_HEALTH_WATCHDOG_VERIFIER_TIMEOUT_MS: "15000",
  });

  const events = readJsonl(traceFile);
  assert(hasType(events, "verifier_attempt"), "watchdog: missing verifier_attempt event");
  const attemptEvent = findEvent(events, "verifier_attempt");
  assert(
    attemptEvent && attemptEvent.modelId === expectedVerifierModel,
    `watchdog: expected verifier modelId='${expectedVerifierModel}'`
  );
  assert(
    hasType(events, "verifier_decision") || hasType(events, "verifier_error"),
    "watchdog: missing verifier_decision/verifier_error event"
  );
  assert(!hasType(events, "retry_triggered"), "watchdog: unexpected retry_triggered in /watchdog-proof");
}

function runWatchdogGateSmoke(traceDir) {
  const traceFile = path.join(traceDir, "watchdog-gate-trace.jsonl");
  runPi("/watchdog-proof-gate", watchdogExtension, {
    PI_HEALTH_WATCHDOG_TRACE_FILE: traceFile,
  });

  const events = readJsonl(traceFile);
  assert(
    hasType(events, "retry_suppressed_verifier_inflight"),
    "watchdog gate: missing retry_suppressed_verifier_inflight event"
  );
  assert(!hasType(events, "retry_triggered"), "watchdog gate: retry triggered despite verifier in flight");
}

function runWatchdogTerminationSmoke(traceDir) {
  const traceFile = path.join(traceDir, "watchdog-termination-trace.jsonl");
  runPi("/watchdog-proof-termination", watchdogExtension, {
    PI_HEALTH_WATCHDOG_TRACE_FILE: traceFile,
    PI_HEALTH_WATCHDOG_RECOVER_ON_TERMINATION: "1",
    PI_HEALTH_WATCHDOG_TERMINATION_MODE: "balanced",
  });

  const events = readJsonl(traceFile);
  assert(hasType(events, "termination_decision"), "watchdog termination: missing termination_decision event");
  assert(
    hasType(events, "termination_recovery_triggered"),
    "watchdog termination: missing termination_recovery_triggered event"
  );
}

function runWatchdogTerminationCompleteSmoke(traceDir) {
  const traceFile = path.join(traceDir, "watchdog-termination-complete-trace.jsonl");
  runPi("/watchdog-proof-termination-complete", watchdogExtension, {
    PI_HEALTH_WATCHDOG_TRACE_FILE: traceFile,
    PI_HEALTH_WATCHDOG_RECOVER_ON_TERMINATION: "1",
    PI_HEALTH_WATCHDOG_TERMINATION_MODE: "balanced",
  });

  const events = readJsonl(traceFile);
  const decisions = findEvents(events, "termination_decision");
  assert(decisions.length > 0, "watchdog termination complete: missing termination_decision event");
  assert(
    decisions.some((event) => event.shouldRetry === false),
    "watchdog termination complete: expected a non-retry decision"
  );
  assert(
    !hasType(events, "termination_recovery_triggered"),
    "watchdog termination complete: unexpected termination_recovery_triggered"
  );
}

function runWatchdogTerminationPostCompleteSmoke(traceDir) {
  const traceFile = path.join(traceDir, "watchdog-termination-post-complete-trace.jsonl");
  runPi("/watchdog-proof-termination-post-complete", watchdogExtension, {
    PI_HEALTH_WATCHDOG_TRACE_FILE: traceFile,
    PI_HEALTH_WATCHDOG_RECOVER_ON_TERMINATION: "1",
    PI_HEALTH_WATCHDOG_TERMINATION_MODE: "balanced",
  });

  const events = readJsonl(traceFile);
  const decisions = findEvents(events, "termination_decision");
  assert(decisions.length > 0, "watchdog post-complete: missing termination_decision event");
  assert(
    decisions.some((event) => event.reason === "prior_complete_output" && event.shouldRetry === false),
    "watchdog post-complete: expected prior_complete_output suppression"
  );
  assert(
    !hasType(events, "termination_recovery_triggered"),
    "watchdog post-complete: unexpected termination_recovery_triggered"
  );
}

function runWatchdogTerminationDuplicateSmoke(traceDir) {
  const traceFile = path.join(traceDir, "watchdog-termination-duplicate-trace.jsonl");
  runPi("/watchdog-proof-termination-duplicate", watchdogExtension, {
    PI_HEALTH_WATCHDOG_TRACE_FILE: traceFile,
    PI_HEALTH_WATCHDOG_RECOVER_ON_TERMINATION: "1",
    PI_HEALTH_WATCHDOG_TERMINATION_MODE: "balanced",
  });

  const events = readJsonl(traceFile);
  assert(
    hasType(events, "termination_recovery_triggered"),
    "watchdog duplicate: missing initial termination_recovery_triggered"
  );
  const suppressed = findEvents(events, "termination_recovery_suppressed");
  assert(
    suppressed.some((event) => event.reason === "duplicate_signature"),
    "watchdog duplicate: expected duplicate_signature suppression"
  );
}

function runWatchdogTerminationUserOverrideSmoke(traceDir) {
  const traceFile = path.join(traceDir, "watchdog-termination-user-override-trace.jsonl");
  runPi("/watchdog-proof-termination-user-override", watchdogExtension, {
    PI_HEALTH_WATCHDOG_TRACE_FILE: traceFile,
    PI_HEALTH_WATCHDOG_RECOVER_ON_TERMINATION: "1",
    PI_HEALTH_WATCHDOG_TERMINATION_MODE: "balanced",
  });

  const events = readJsonl(traceFile);
  const suppressed = findEvents(events, "termination_recovery_suppressed");
  assert(
    suppressed.some((event) => event.reason === "newer_user_prompt"),
    "watchdog user override: expected newer_user_prompt suppression"
  );
  assert(
    !hasType(events, "termination_recovery_triggered"),
    "watchdog user override: unexpected termination_recovery_triggered"
  );
}

function runWatchdogWriteSchemaLoopSmoke(traceDir) {
  const traceFile = path.join(traceDir, "watchdog-write-schema-loop-trace.jsonl");
  runPi("/watchdog-proof-write-schema-loop", watchdogExtension, {
    PI_HEALTH_WATCHDOG_TRACE_FILE: traceFile,
    PI_HEALTH_WATCHDOG_RECOVER_ON_TERMINATION: "1",
    PI_HEALTH_WATCHDOG_TERMINATION_MODE: "balanced",
  });

  const events = readJsonl(traceFile);
  assert(
    hasType(events, "write_schema_error_detected"),
    "watchdog write-schema: missing write_schema_error_detected"
  );
  assert(
    hasType(events, "write_schema_guard_triggered"),
    "watchdog write-schema: missing write_schema_guard_triggered"
  );
  assert(
    !hasType(events, "termination_recovery_triggered"),
    "watchdog write-schema: unexpected termination recovery trigger"
  );
}

function runWatchdogFinalTailSmoke(traceDir) {
  const traceFile = path.join(traceDir, "watchdog-final-tail-trace.jsonl");
  runPi("/watchdog-proof-final-tail", watchdogExtension, {
    PI_HEALTH_WATCHDOG_TRACE_FILE: traceFile,
    PI_HEALTH_WATCHDOG_RECOVER_ON_TERMINATION: "1",
    PI_HEALTH_WATCHDOG_TERMINATION_MODE: "balanced",
    PI_HEALTH_WATCHDOG_FINAL_TAIL_GRACE_MS: "15000",
  });

  const events = readJsonl(traceFile);
  const suppressed = findEvents(events, "termination_recovery_suppressed");
  assert(
    suppressed.some((event) => event.reason === "final_tail_pending"),
    "watchdog final-tail: expected final_tail_pending suppression"
  );
  assert(
    !hasType(events, "termination_recovery_triggered"),
    "watchdog final-tail: unexpected termination_recovery_triggered"
  );
}

function runResearchSmoke(traceDir) {
  const traceFile = path.join(traceDir, "research-trace.jsonl");
  runPi("/research-status", researchExtension, {
    PI_RESEARCH_TRACE_FILE: traceFile,
    PI_RESEARCH_DCS_ROOT: "/Users/trevon/work/tools/yams/external/agent",
    PI_RESEARCH_FRAMEWORK_CLI: "research-agent",
  }, 240000);

  const events = readJsonl(traceFile);
  assert(hasType(events, "session_start"), "research: missing session_start event");
  assert(hasType(events, "status"), "research: missing status event");
  const statusEvent = findEvent(events, "status");
  assert(statusEvent && typeof statusEvent.frameworkModel === "string", "research: status missing frameworkModel field");
  assert(statusEvent && statusEvent.frameworkCli === "research-agent", "research: status missing framework cli usage");
  assert(
    statusEvent && statusEvent.frameworkModel === "unsloth/qwen3.5-35b-a3b",
    "research: framework model not aligned to primary"
  );
}

function runRuntimeTraceSmoke(traceDir) {
  const traceFile = path.join(traceDir, "runtime-trace.jsonl");
  runPi("/trace status", runtimeTraceExtension, {
    PI_RUNTIME_TRACE_FILE: traceFile,
    PI_RUNTIME_TRACE_ENABLED: "1",
  });

  runPi("/doctor", runtimeTraceExtension, {
    PI_RUNTIME_TRACE_FILE: traceFile,
    PI_RUNTIME_TRACE_ENABLED: "1",
  });

  const events = readJsonl(traceFile);
  assert(hasType(events, "session_start"), "runtime-trace: missing session_start event");
  assert(hasType(events, "trace_status"), "runtime-trace: missing trace_status event");
  assert(hasType(events, "doctor"), "runtime-trace: missing doctor event");
}

function main() {
  const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness-smoke-"));
  runHybridSmoke(traceDir);
  runHybridFlowSmoke(traceDir);
  runOracleSmoke(traceDir);
  runWatchdogSmoke(traceDir);
  runWatchdogGateSmoke(traceDir);
  runWatchdogTerminationSmoke(traceDir);
  runWatchdogTerminationCompleteSmoke(traceDir);
  runWatchdogTerminationPostCompleteSmoke(traceDir);
  runWatchdogTerminationDuplicateSmoke(traceDir);
  runWatchdogTerminationUserOverrideSmoke(traceDir);
  runWatchdogWriteSchemaLoopSmoke(traceDir);
  runWatchdogFinalTailSmoke(traceDir);
  runResearchSmoke(traceDir);
  runRuntimeTraceSmoke(traceDir);
  console.log(`Smoke tests passed. traces=${traceDir}`);
}

main();
