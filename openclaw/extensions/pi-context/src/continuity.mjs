const TERMINAL_STATUSES = new Set([
  "error",
  "failed",
  "cancelled",
  "canceled",
  "stopped",
  "aborted",
  "timeout",
  "timed_out",
]);

function normalizeText(input) {
  return String(input ?? "").replace(/\s+/g, " ").trim();
}

function truncate(input, maxChars) {
  return input.length > maxChars ? `${input.slice(0, Math.max(0, maxChars - 3))}...` : input;
}

function collectStrings(value, out = []) {
  if (!value) return out;
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  if (typeof value === "object") {
    for (const key of Object.keys(value)) collectStrings(value[key], out);
  }
  return out;
}

function pickStatus(payload) {
  const candidates = [
    payload?.status,
    payload?.state,
    payload?.result?.status,
    payload?.run?.status,
    payload?.runState,
    payload?.outcome,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
  }
  return "";
}

function extractErrorText(payload) {
  const direct = [
    payload?.error,
    payload?.lastError,
    payload?.result?.error,
    payload?.run?.error,
    payload?.failure,
  ];
  const parts = [];
  for (const value of direct) collectStrings(value, parts);
  return normalizeText(parts.join(" "));
}

export function detectContinuityIssue(payload, userPrompt, assistantText) {
  const prompt = normalizeText(userPrompt);
  const reply = normalizeText(assistantText);
  const status = pickStatus(payload);
  const errorText = extractErrorText(payload);

  if (TERMINAL_STATUSES.has(status)) {
    return {
      kind: "terminal-status",
      reason: `Run ended with status "${status}"${errorText ? `: ${truncate(errorText, 200)}` : ""}`,
      prompt,
      assistantText: reply,
      fingerprint: `${status}:${prompt.slice(0, 240)}`,
    };
  }

  if (errorText) {
    return {
      kind: "error-text",
      reason: `Run ended with an error: ${truncate(errorText, 200)}`,
      prompt,
      assistantText: reply,
      fingerprint: `error:${prompt.slice(0, 240)}:${errorText.slice(0, 120)}`,
    };
  }

  if (!reply) {
    return {
      kind: "empty-assistant",
      reason: "Run ended without any assistant reply text.",
      prompt,
      assistantText: "",
      fingerprint: `empty:${prompt.slice(0, 240)}`,
    };
  }

  return null;
}

export function shouldUseRecovery(state, cfg, now = Date.now()) {
  if (!state?.pendingRecovery) return false;
  if (!cfg?.continuityWatchdogEnabled) return false;
  const retryCount = Number(state.retryCount || 0);
  const maxRetries = Number(cfg.continuityMaxRetries || 0);
  if (retryCount >= maxRetries) return false;
  const cooldownMs = Number(cfg.continuityCooldownMs || 0);
  const lastAt = Number(state.lastRecoveryAt || 0);
  if (cooldownMs > 0 && lastAt > 0 && now - lastAt < cooldownMs) return false;
  return true;
}

export function buildRecoveryContext(state) {
  const recovery = state?.pendingRecovery;
  if (!recovery) return "";
  const lines = [
    "[Pi Continuity Watchdog]",
    "The previous agent run appears to have stopped abnormally or without a usable final answer.",
    `Reason: ${recovery.reason}`,
  ];
  if (recovery.prompt) {
    lines.push(`Previous user request: ${truncate(recovery.prompt, 600)}`);
  }
  if (recovery.assistantText) {
    lines.push(`Partial assistant output: ${truncate(recovery.assistantText, 600)}`);
  }
  lines.push("Recover gracefully: continue from the last good state, avoid repeating finished work, and produce a complete final answer.");
  return lines.join("\n\n");
}

export function shouldHeartbeatRefresh(state, cfg, now = Date.now()) {
  if (!cfg?.activityHeartbeatEnabled) return false;
  if (!state) return false;
  const thresholdMs = Number(cfg.activityHeartbeatMs || 0);
  if (thresholdMs <= 0) return false;
  const baseline = Math.max(
    Number(state.lastRlmAt || 0),
    Number(state.lastActivityAt || 0),
    Number(state.lastRecoveryAt || 0)
  );
  if (baseline <= 0) return false;
  if (!String(state.lastQuery || state.lastRawPrompt || "").trim()) return false;
  return now - baseline >= thresholdMs;
}
