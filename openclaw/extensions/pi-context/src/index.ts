import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildRecoveryContext, detectContinuityIssue, shouldHeartbeatRefresh, shouldUseRecovery } from "./continuity.mjs";

const execFileAsync = promisify(execFile);

const DEFAULTS = {
  enabledRlm: true,
  enabledDcs: false,
  yamsBinary: "yams",
  yamsCwd: "/workspace/dotfiles",
  rlmCollection: "pi-session-memory",
  rlmGlobalTag: "rlm-openclaw",
  rlmSimilarity: 0.001,
  rlmLimit: 3,
  rlmBaseMinScore: 0.003,
  rlmDynamicPolicy: true,
  autoStore: true,
  storeLimit: 3,
  continuityWatchdogEnabled: true,
  continuityMaxRetries: 1,
  continuityCooldownMs: 120000,
  activityHeartbeatEnabled: true,
  activityHeartbeatMs: 1800000,
  activityHeartbeatPollMs: 300000,
  lmstudioBaseUrl: "http://host.docker.internal:1234/v1",
  sidecarModel: "qwen_qwen3.5-9b",
  dcsCli: "research-agent",
  dcsContextProfile: "small",
} as const;

const RLM_RETRIEVE_TIMEOUT_MS = 8000;
const SIDECAR_QUERY_TIMEOUT_MS = 12000;
const RLM_STORE_TIMEOUT_MS = 10000;
const RLM_TEMPFILE_TTL_MS = 60000;

type PluginApi = {
  config?: any;
  logger?: {
    info?: (...args: any[]) => void;
    warn?: (...args: any[]) => void;
    error?: (...args: any[]) => void;
    debug?: (...args: any[]) => void;
  };
  on?: (event: string, handler: (payload: any) => any) => void;
  registerCommand?: (...args: any[]) => any;
  registerHook?: (...args: any[]) => any;
  registerService?: (...args: any[]) => any;
};

type PluginConfig = {
  enabledRlm: boolean;
  enabledDcs: boolean;
  yamsBinary: string;
  yamsCwd: string;
  rlmCollection: string;
  rlmGlobalTag: string;
  rlmSimilarity: number;
  rlmLimit: number;
  rlmBaseMinScore: number;
  rlmDynamicPolicy: boolean;
  autoStore: boolean;
  storeLimit: number;
  continuityWatchdogEnabled: boolean;
  continuityMaxRetries: number;
  continuityCooldownMs: number;
  activityHeartbeatEnabled: boolean;
  activityHeartbeatMs: number;
  activityHeartbeatPollMs: number;
  lmstudioBaseUrl: string;
  sidecarModel: string;
  dcsCli: string;
  dcsContextProfile: string;
};

type RlmHint = {
  id: string;
  snippet: string;
  score: number;
  chunkType: string;
  path?: string;
};

type SessionState = {
  sessionTag: string;
  lastQuery: string;
  lastRawPrompt: string;
  lastHints: RlmHint[];
  lastRlmAt: number;
  lastActivityAt: number;
  retryCount: number;
  lastRecoveryAt: number;
  pendingRecovery: null | {
    reason: string;
    kind: string;
    prompt: string;
    assistantText: string;
    fingerprint: string;
  };
  storeInFlight: boolean;
};

type MemoryChunk = {
  chunkType: string;
  content: string;
};

class TempFileManager {
  private timers = new Set<ReturnType<typeof setTimeout>>();

  register(tmpFile: string, ttlMs: number = RLM_TEMPFILE_TTL_MS): void {
    const timer = setTimeout(() => {
      fs.unlink(tmpFile).catch(() => undefined);
      this.timers.delete(timer);
    }, ttlMs);
    this.timers.add(timer);
  }
}

const rlmTempFileManager = new TempFileManager();

const rlmPolicyState = {
  minScore: DEFAULTS.rlmBaseMinScore,
  retrievalCounts: [] as number[],
  noiseRates: [] as number[],
};

function currentRlmMinScore(cfg: PluginConfig): number {
  return cfg.rlmDynamicPolicy ? rlmPolicyState.minScore : cfg.rlmBaseMinScore;
}

function scoreHint(h: RlmHint): number {
  const t = h.chunkType.toLowerCase();
  const w = t === "decision" || t === "objective"
    ? 0.12
    : t === "assistant-finding" || t === "code-change"
      ? 0.08
      : t === "tool-outcome" || t === "file-context" || t === "unknown"
        ? -0.05
        : 0;
  return h.score + w;
}

function rankHints(hints: RlmHint[]): RlmHint[] {
  return [...hints].sort((a, b) => scoreHint(b) - scoreHint(a));
}

function adaptRlmPolicy(cfg: PluginConfig, hints: RlmHint[]): void {
  if (!cfg.rlmDynamicPolicy) return;
  const count = hints.length;
  const noisy = hints.filter((h) => {
    const t = h.chunkType.toLowerCase();
    return t === "unknown" || t === "tool-outcome" || t === "file-context";
  }).length;
  const noiseRate = count > 0 ? noisy / count : 1;

  rlmPolicyState.retrievalCounts.push(count);
  rlmPolicyState.noiseRates.push(noiseRate);
  if (rlmPolicyState.retrievalCounts.length > 40) rlmPolicyState.retrievalCounts.shift();
  if (rlmPolicyState.noiseRates.length > 40) rlmPolicyState.noiseRates.shift();

  const zeroRate =
    rlmPolicyState.retrievalCounts.length > 0
      ? rlmPolicyState.retrievalCounts.filter((v) => v === 0).length / rlmPolicyState.retrievalCounts.length
      : 0;
  const avgNoise =
    rlmPolicyState.noiseRates.length > 0
      ? rlmPolicyState.noiseRates.reduce((a, b) => a + b, 0) / rlmPolicyState.noiseRates.length
      : 0;

  if (avgNoise >= 0.6) {
    rlmPolicyState.minScore = Math.min(0.009, rlmPolicyState.minScore + 0.0005);
  } else if (zeroRate >= 0.7) {
    rlmPolicyState.minScore = Math.max(0.0015, rlmPolicyState.minScore - 0.0004);
  } else {
    const target = cfg.rlmBaseMinScore;
    if (rlmPolicyState.minScore < target) rlmPolicyState.minScore = Math.min(target, rlmPolicyState.minScore + 0.0002);
    else if (rlmPolicyState.minScore > target) rlmPolicyState.minScore = Math.max(target, rlmPolicyState.minScore - 0.0002);
  }
}

function getPluginConfig(api: PluginApi): PluginConfig {
  const raw = api?.config?.plugins?.entries?.["pi-context"]?.config ?? {};
  return {
    enabledRlm: raw.enabledRlm ?? DEFAULTS.enabledRlm,
    enabledDcs: raw.enabledDcs ?? DEFAULTS.enabledDcs,
    yamsBinary: String(raw.yamsBinary ?? DEFAULTS.yamsBinary),
    yamsCwd: String(raw.yamsCwd ?? DEFAULTS.yamsCwd),
    rlmCollection: String(raw.rlmCollection ?? DEFAULTS.rlmCollection),
    rlmGlobalTag: String(raw.rlmGlobalTag ?? DEFAULTS.rlmGlobalTag),
    rlmSimilarity: Number(raw.rlmSimilarity ?? DEFAULTS.rlmSimilarity),
    rlmLimit: Number(raw.rlmLimit ?? DEFAULTS.rlmLimit),
    rlmBaseMinScore: Number(raw.rlmBaseMinScore ?? DEFAULTS.rlmBaseMinScore),
    rlmDynamicPolicy: raw.rlmDynamicPolicy ?? DEFAULTS.rlmDynamicPolicy,
    autoStore: raw.autoStore ?? DEFAULTS.autoStore,
    storeLimit: Number(raw.storeLimit ?? DEFAULTS.storeLimit),
    continuityWatchdogEnabled: raw.continuityWatchdogEnabled ?? DEFAULTS.continuityWatchdogEnabled,
    continuityMaxRetries: Number(raw.continuityMaxRetries ?? DEFAULTS.continuityMaxRetries),
    continuityCooldownMs: Number(raw.continuityCooldownMs ?? DEFAULTS.continuityCooldownMs),
    activityHeartbeatEnabled: raw.activityHeartbeatEnabled ?? DEFAULTS.activityHeartbeatEnabled,
    activityHeartbeatMs: Number(raw.activityHeartbeatMs ?? DEFAULTS.activityHeartbeatMs),
    activityHeartbeatPollMs: Number(raw.activityHeartbeatPollMs ?? DEFAULTS.activityHeartbeatPollMs),
    lmstudioBaseUrl: String(raw.lmstudioBaseUrl ?? DEFAULTS.lmstudioBaseUrl),
    sidecarModel: String(raw.sidecarModel ?? DEFAULTS.sidecarModel),
    dcsCli: String(raw.dcsCli ?? DEFAULTS.dcsCli),
    dcsContextProfile: String(raw.dcsContextProfile ?? DEFAULTS.dcsContextProfile),
  };
}

function log(api: PluginApi, level: "info" | "warn" | "error" | "debug", message: string, extra?: any): void {
  const fn = api?.logger?.[level];
  if (typeof fn === "function") {
    if (extra === undefined) fn(`[pi-context] ${message}`);
    else fn(`[pi-context] ${message}`, extra);
  }
}

function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function truncate(input: string, maxChars: number): string {
  return input.length > maxChars ? `${input.slice(0, Math.max(0, maxChars - 3))}...` : input;
}

function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (typeof block?.text === "string") return block.text;
        if (typeof block?.content === "string") return block.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content?.text === "string") return content.text;
  return "";
}

function extractPrompt(payload: any): string {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role === "user") {
      const text = extractText(msg?.content);
      if (text.trim()) return text;
    }
  }
  return String(payload?.prompt || payload?.input || "");
}

function getSessionKey(payload: any): string {
  const candidates = [
    payload?.sessionId,
    payload?.conversationId,
    payload?.threadId,
    payload?.chatId,
    payload?.ctx?.sessionId,
    payload?.ctx?.conversationId,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "default";
}

function getSessionTag(sessionKey: string): string {
  return `session:openclaw-${sessionKey.replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 80)}`;
}

async function runYams(
  cfg: PluginConfig,
  args: string[],
  timeoutMs: number
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout = "", stderr = "" } = await execFileAsync(cfg.yamsBinary, args, {
      cwd: cfg.yamsCwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
    });
    return { code: 0, stdout, stderr };
  } catch (error: any) {
    return {
      code: Number.isInteger(error?.code) ? error.code : 1,
      stdout: String(error?.stdout ?? ""),
      stderr: String(error?.stderr ?? error?.message ?? error ?? ""),
    };
  }
}

function parseSearchResults(cfg: PluginConfig, stdout: string, seen: Set<string>): RlmHint[] {
  try {
    const parsed = JSON.parse(stdout);
    const results = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.results) ? parsed.results : [];
    const hints: RlmHint[] = [];
    for (const row of results) {
      if (typeof row?.score !== "number" || row.score < currentRlmMinScore(cfg)) continue;
      if (typeof row?.snippet !== "string" || !row.snippet.trim()) continue;
      const id = String(row?.id || row?.path || row?.snippet.slice(0, 80));
      if (seen.has(id)) continue;
      seen.add(id);
      hints.push({
        id,
        snippet: normalizeText(row.snippet),
        score: row.score,
        chunkType: String(row?.metadata?.chunk_type || (typeof row?.path === "string" ? String(row.path).match(/-([\w][\w-]*)-\d+$/)?.[1] : "") || "unknown"),
        path: typeof row?.path === "string" ? row.path : undefined,
      });
    }
    return hints;
  } catch {
    return [];
  }
}

async function searchRlm(cfg: PluginConfig, query: string, sessionTag?: string): Promise<RlmHint[]> {
  const normalized = truncate(normalizeText(query), 900);
  if (!normalized) return [];

  const seen = new Set<string>();
  const hints: RlmHint[] = [];

  if (sessionTag) {
    const sessionArgs = [
      "search",
      "--json",
      "--collection",
      cfg.rlmCollection,
      "--tags",
      sessionTag,
      "--similarity",
      String(cfg.rlmSimilarity),
      "--limit",
      String(cfg.rlmLimit + 2),
      normalized,
    ];
    const sessionResult = await runYams(cfg, sessionArgs, RLM_RETRIEVE_TIMEOUT_MS);
    if (sessionResult.code !== 0) {
      console.warn("[pi-context] yams session search failed", {
        code: sessionResult.code,
        stderr: sessionResult.stderr,
        cwd: cfg.yamsCwd,
      });
    }
    if (sessionResult.code === 0 && sessionResult.stdout) {
      hints.push(...parseSearchResults(cfg, sessionResult.stdout, seen).slice(0, cfg.rlmLimit));
    }
  }

  const remaining = cfg.rlmLimit - hints.length;
  if (remaining > 0) {
    const globalArgs = [
      "search",
      "--json",
      "--collection",
      cfg.rlmCollection,
      "--tags",
      cfg.rlmGlobalTag,
      "--similarity",
      String(cfg.rlmSimilarity),
      "--limit",
      String(remaining + 2),
      normalized,
    ];
    const globalResult = await runYams(cfg, globalArgs, RLM_RETRIEVE_TIMEOUT_MS);
    if (globalResult.code !== 0) {
      console.warn("[pi-context] yams global search failed", {
        code: globalResult.code,
        stderr: globalResult.stderr,
        cwd: cfg.yamsCwd,
      });
    }
    if (globalResult.code === 0 && globalResult.stdout) {
      hints.push(...parseSearchResults(cfg, globalResult.stdout, seen).slice(0, remaining));
    }
  }

  const ranked = rankHints(hints).slice(0, cfg.rlmLimit);
  adaptRlmPolicy(cfg, ranked);
  return ranked;
}

async function storeRlmChunk(cfg: PluginConfig, sessionTag: string, chunk: MemoryChunk, index: number): Promise<boolean> {
  const tmpFile = path.join(os.tmpdir(), `pi-context-rlm-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}.txt`);
  const normalized = normalizeText(chunk.content);
  if (!normalized) return false;
  await fs.writeFile(tmpFile, normalized, "utf8");
  const name = `openclaw-rlm-${Date.now().toString(36)}-${chunk.chunkType}-${index}`;
  const metadata = `chunk_type=${chunk.chunkType},source=openclaw,owner=pi-context,session_tag=${sessionTag}`;
  const tags = `${cfg.rlmGlobalTag},pi-session-memory,${sessionTag}`;
  try {
    const result = await runYams(
      cfg,
      [
        "add",
        tmpFile,
        "--name",
        name,
        "--collection",
        cfg.rlmCollection,
        "--tags",
        tags,
        "--metadata",
        metadata,
      ],
      RLM_STORE_TIMEOUT_MS
    );
    if (result.code !== 0) {
      console.warn("[pi-context] yams store failed", {
        code: result.code,
        stderr: result.stderr,
        cwd: cfg.yamsCwd,
        chunkType: chunk.chunkType,
        sessionTag,
        name,
      });
    }
    return result.code === 0;
  } finally {
    rlmTempFileManager.register(tmpFile);
  }
}

function formatHints(hints: RlmHint[]): string {
  return hints
    .map((hint, index) => {
      const prefix = `${index + 1}. [${hint.chunkType}] score=${hint.score.toFixed(3)}`;
      const suffix = hint.path ? ` path=${hint.path}` : "";
      return `${prefix}${suffix}\n${truncate(hint.snippet, 400)}`;
    })
    .join("\n\n");
}

async function replyOrReturn(ctx: any, message: string): Promise<any> {
  if (typeof ctx?.reply === "function") {
    return ctx.reply(message);
  }
  if (typeof ctx?.notify === "function") {
    return ctx.notify(message);
  }
  return message;
}

function formatTimestamp(epochMs: number): string {
  if (!epochMs || !Number.isFinite(epochMs)) return "(never)";
  try {
    return new Date(epochMs).toISOString();
  } catch {
    return String(epochMs);
  }
}

function registerCommand(api: PluginApi, spec: any): void {
  if (typeof api?.registerCommand !== "function") return;
  try {
    api.registerCommand(spec);
  } catch {
    try {
      api.registerCommand(spec.name, spec);
    } catch {
      // ignore registration mismatch
    }
  }
}

function registerHook(api: PluginApi, event: string, handler: (payload: any) => any, meta?: any): void {
  if (typeof api?.registerHook === "function") {
    try {
      api.registerHook(event, handler, meta || { name: `pi-context.${event}`, description: `pi-context hook for ${event}` });
      return;
    } catch {
      // fall through
    }
  }
  if (typeof api?.on === "function") {
    try {
      api.on(event, handler);
    } catch {
      // ignore registration mismatch
    }
  }
}

async function refineQueryWithSidecar(cfg: PluginConfig, rawPrompt: string): Promise<string> {
  const prompt = truncate(normalizeText(rawPrompt), 4000);
  if (!prompt) return "";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SIDECAR_QUERY_TIMEOUT_MS);

  try {
    const response = await fetch(`${cfg.lmstudioBaseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer lmstudio",
      },
      body: JSON.stringify({
        model: cfg.sidecarModel,
        temperature: 0,
        max_tokens: 120,
        stream: false,
        messages: [
          {
            role: "system",
            content: [
              "Rewrite the user's latest request into a compact retrieval query for project memory search.",
              "Preserve exact file paths, identifiers, error strings, model names, ports, and config keys.",
              "Return plain text only. No bullets, no explanation, no markdown.",
            ].join(" "),
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    });

    if (!response.ok) return prompt;
    const json: any = await response.json();
    const content = json?.choices?.[0]?.message?.content;
    const refined = normalizeText(extractText(content));
    return refined || prompt;
  } catch {
    return prompt;
  } finally {
    clearTimeout(timer);
  }
}

async function extractMemoryChunksWithSidecar(
  cfg: PluginConfig,
  userPrompt: string,
  assistantText: string
): Promise<MemoryChunk[]> {
  const prompt = truncate(normalizeText(userPrompt), 3000);
  const reply = truncate(normalizeText(assistantText), 4000);
  if (!prompt || !reply) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SIDECAR_QUERY_TIMEOUT_MS);

  try {
    const response = await fetch(`${cfg.lmstudioBaseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer lmstudio",
      },
      body: JSON.stringify({
        model: cfg.sidecarModel,
        temperature: 0,
        max_tokens: 220,
        stream: false,
        messages: [
          {
            role: "system",
            content: [
              "Extract durable coding-session memory worth saving for later retrieval.",
              `Return strict JSON array only, max ${cfg.storeLimit} items.`,
              'Each item must be {"chunkType":"decision|blocker|path|objective|note","content":"..."}',
              "Keep content concise and factual. Preserve exact file paths, identifiers, model names, ports, and config keys.",
              "Skip generic conversational text.",
            ].join(" "),
          },
          {
            role: "user",
            content: `User prompt:\n${prompt}\n\nAssistant final reply:\n${reply}`,
          },
        ],
      }),
    });

    if (!response.ok) return [];
    const json: any = await response.json();
    const raw = extractText(json?.choices?.[0]?.message?.content).replace(/```json|```/gi, "").trim();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const chunks: MemoryChunk[] = [];
    for (const item of parsed) {
      const chunkType = normalizeText(String(item?.chunkType || "note")).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "note";
      const content = truncate(normalizeText(String(item?.content || "")), 600);
      if (!content) continue;
      chunks.push({ chunkType, content });
      if (chunks.length >= cfg.storeLimit) break;
    }
    return chunks;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function findLatestMessageText(payload: any, role: string): string {
  const candidates = [payload?.messages, payload?.finalMessages, payload?.outputMessages];
  for (const candidate of candidates) {
    const messages = Array.isArray(candidate) ? candidate : [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg?.role === role) {
        const text = extractText(msg?.content);
        if (text.trim()) return text;
      }
    }
  }
  return "";
}

function heuristicMemoryChunks(userPrompt: string, assistantText: string, storeLimit: number): MemoryChunk[] {
  const chunks: MemoryChunk[] = [];
  const user = truncate(normalizeText(userPrompt), 500);
  const assistant = truncate(normalizeText(assistantText), 700);
  if (user) {
    chunks.push({
      chunkType: "objective",
      content: `User request: ${user}`,
    });
  }
  if (assistant) {
    chunks.push({
      chunkType: "assistant_finding",
      content: `Assistant outcome: ${assistant}`,
    });
  }
  return chunks.slice(0, Math.max(1, storeLimit));
}

function stopHeartbeatLoop(): void {
  const timer = (globalThis as any).__piContextHeartbeatTimer;
  if (timer) {
    clearInterval(timer);
    delete (globalThis as any).__piContextHeartbeatTimer;
  }
}

function startHeartbeatLoop(api: PluginApi, cfg: PluginConfig, sessions: Map<string, SessionState>, ctx?: any): void {
  stopHeartbeatLoop();
  const pollMs = Math.max(30_000, Number(cfg.activityHeartbeatPollMs || 300_000));
  const timer = setInterval(async () => {
    const now = Date.now();
    for (const [sessionKey, session] of sessions.entries()) {
      if (!shouldHeartbeatRefresh(session, cfg, now)) continue;
      try {
        const query = session.lastQuery || session.lastRawPrompt;
        const hints = await searchRlm(cfg, query, session.sessionTag);
        session.lastHints = hints;
        session.lastRlmAt = Date.now();
        ctx?.logger?.info?.(`[pi-context] activity heartbeat refreshed RLM for ${sessionKey} (hits=${hints.length})`);
      } catch (error: any) {
        ctx?.logger?.warn?.(
          `[pi-context] activity heartbeat refresh failed for ${sessionKey}: ${String(error?.message || error)}`
        );
      }
    }
  }, pollMs);
  (globalThis as any).__piContextHeartbeatTimer = timer;
  log(api, "info", "activity heartbeat loop started", {
    pollMs,
    mode: typeof api?.registerService === "function" ? "service" : "fallback",
  });
}

export default function piContextPlugin(api: PluginApi): void {
  const cfg = getPluginConfig(api);
  const sessions = new Map<string, SessionState>();

  function ensureSession(sessionKey: string): SessionState {
    const existing = sessions.get(sessionKey);
    if (existing) return existing;
    const created: SessionState = {
      sessionTag: getSessionTag(sessionKey),
      lastQuery: "",
      lastRawPrompt: "",
      lastHints: [],
      lastRlmAt: 0,
      lastActivityAt: 0,
      retryCount: 0,
      lastRecoveryAt: 0,
      pendingRecovery: null,
      storeInFlight: false,
    };
    sessions.set(sessionKey, created);
    return created;
  }

  registerCommand(api, {
    name: "rlm",
    description: "Show Pi-context RLM status for the current OpenClaw session.",
    handler: async (_args: any, ctx: any) => {
      const sessionKey = getSessionKey(ctx);
      const session = ensureSession(sessionKey);
      const lines = [
        `RLM enabled: ${cfg.enabledRlm}`,
        `Sidecar model: ${cfg.sidecarModel}`,
        `YAMS cwd: ${cfg.yamsCwd}`,
        `Collection: ${cfg.rlmCollection}`,
        `Global tag: ${cfg.rlmGlobalTag}`,
        `Min score: ${currentRlmMinScore(cfg).toFixed(4)} (dynamic=${cfg.rlmDynamicPolicy})`,
        `Session tag: ${session.sessionTag}`,
        `Session key: ${sessionKey}`,
        `Tracked sessions: ${sessions.size}`,
        `Continuity watchdog: ${cfg.continuityWatchdogEnabled}`,
        `Continuity retries used: ${session.retryCount}/${cfg.continuityMaxRetries}`,
        `Activity heartbeat: ${cfg.activityHeartbeatEnabled}`,
        `Heartbeat threshold: ${cfg.activityHeartbeatMs}ms`,
        `Last activity at: ${formatTimestamp(session.lastActivityAt)}`,
        `Last RLM at: ${formatTimestamp(session.lastRlmAt)}`,
        `Last recovery at: ${formatTimestamp(session.lastRecoveryAt)}`,
        `Last prompt: ${session.lastRawPrompt || "(none)"}`,
        `Last query: ${session.lastQuery || "(none)"}`,
        `Retrieved chunks: ${session.lastHints.length}`,
      ];
      if (session.pendingRecovery) {
        lines.push("");
        lines.push(`Pending recovery: ${session.pendingRecovery.reason}`);
      }
      if (session.lastHints.length > 0) {
        lines.push("");
        lines.push("Recalled memory:");
        lines.push(formatHints(session.lastHints));
      }
      if (sessions.size > 1) {
        lines.push("");
        lines.push("Known session keys:");
        lines.push(Array.from(sessions.keys()).slice(0, 12).map((key) => `- ${key}`).join("\n"));
      }
      return replyOrReturn(ctx, lines.join("\n"));
    },
  });

  registerCommand(api, {
    name: "rlm-all",
    description: "Show tracked Pi-context sessions and their recall state.",
    handler: async (_args: any, ctx: any) => {
      if (sessions.size === 0) {
        return replyOrReturn(ctx, "No pi-context sessions tracked yet.");
      }
      const lines: string[] = ["Tracked pi-context sessions:"];
      for (const [key, session] of Array.from(sessions.entries()).slice(0, 20)) {
        lines.push(
          [
            `- ${key}`,
            `  tag=${session.sessionTag}`,
            `  prompt=${session.lastRawPrompt ? truncate(session.lastRawPrompt, 120) : "(none)"}`,
            `  query=${session.lastQuery ? truncate(session.lastQuery, 120) : "(none)"}`,
            `  hints=${session.lastHints.length}`,
            `  lastActivityAt=${formatTimestamp(session.lastActivityAt)}`,
            `  lastRlmAt=${formatTimestamp(session.lastRlmAt)}`,
            `  pendingRecovery=${session.pendingRecovery ? session.pendingRecovery.kind : "none"}`,
            `  lastRecoveryAt=${formatTimestamp(session.lastRecoveryAt)}`,
          ].join("\n")
        );
      }
      return replyOrReturn(ctx, lines.join("\n"));
    },
  });

  const runRecall = async (payload: any, hookName: string) => {
    try {
      const prompt = extractPrompt(payload);
      const sessionKey = getSessionKey(payload);
      const session = ensureSession(sessionKey);
      session.lastActivityAt = Date.now();
      log(api, "info", `${hookName} received payload`, {
        sessionKey,
        hasPrompt: Boolean(prompt.trim()),
        messageCount: Array.isArray(payload?.messages) ? payload.messages.length : 0,
        payloadKeys: Object.keys(payload || {}).slice(0, 20),
      });
      if (!prompt.trim()) return null;
      const refinedQuery = await refineQueryWithSidecar(cfg, prompt);
      log(api, "info", "recall query built", {
        hookName,
        sessionKey,
        sessionTag: session.sessionTag,
        sidecarModel: cfg.sidecarModel,
        rawPromptChars: prompt.length,
        refinedQueryChars: refinedQuery.length,
      });
      const hints = await searchRlm(cfg, refinedQuery, session.sessionTag);
      session.lastRawPrompt = prompt;
      session.lastQuery = refinedQuery;
      session.lastHints = hints;
      session.lastRlmAt = Date.now();
      log(api, "info", "recall search complete", {
        hookName,
        sessionKey,
        sessionTag: session.sessionTag,
        yamsCwd: cfg.yamsCwd,
        hits: hints.length,
        queryPreview: truncate(refinedQuery, 180),
      });

      const prependParts: string[] = [];
      if (hints.length > 0) {
        prependParts.push(
          [
            "[Pi Context Recall]",
            `Background model: ${cfg.sidecarModel}`,
            "Recalled session/global memory from YAMS. Treat these as candidate evidence and verify against current files and tool output.",
            formatHints(hints),
          ].join("\n\n")
        );
      }

      if (shouldUseRecovery(session, cfg)) {
        const recoveryContext = buildRecoveryContext(session);
        if (recoveryContext) {
          prependParts.push(recoveryContext);
          session.retryCount += 1;
          session.lastRecoveryAt = Date.now();
          log(api, "warn", "continuity watchdog injected recovery context", {
            sessionTag: session.sessionTag,
            retryCount: session.retryCount,
            maxRetries: cfg.continuityMaxRetries,
            reason: session.pendingRecovery?.reason,
          });
          session.pendingRecovery = null;
        }
      }

      if (prependParts.length === 0) return null;
      return {
        prependSystemContext: prependParts.join("\n\n"),
      };
    } catch (error) {
      log(api, "warn", `${hookName} recall failed`, error);
      return null;
    }
  };

  if (cfg.enabledRlm) {
    registerHook(api, "before_prompt_build", async (payload: any) => runRecall(payload, "before_prompt_build"), {
      name: "pi-context.before-prompt-build",
      description: "Inject YAMS-based recalled context before prompt assembly",
    });
    registerHook(api, "before_agent_start", async (payload: any) => runRecall(payload, "before_agent_start"), {
      name: "pi-context.before-agent-start",
      description: "Fallback YAMS recall hook before agent start",
    });
  }

  if (cfg.enabledRlm && cfg.autoStore) {
    registerHook(api, "agent_end", async (payload: any) => {
      try {
        const sessionKey = getSessionKey(payload);
        const session = ensureSession(sessionKey);
        session.lastActivityAt = Date.now();
        const userPrompt = findLatestMessageText(payload, "user") || session.lastRawPrompt;
        const assistantText = findLatestMessageText(payload, "assistant");
        log(api, "info", "agent_end received payload", {
          sessionKey,
          hasUserPrompt: Boolean(userPrompt.trim()),
          hasAssistantText: Boolean(assistantText.trim()),
          userPromptChars: userPrompt.length,
          assistantChars: assistantText.length,
          payloadKeys: Object.keys(payload || {}).slice(0, 20),
        });
        if (cfg.continuityWatchdogEnabled) {
          const issue = detectContinuityIssue(payload, userPrompt, assistantText);
          if (issue) {
            const isDuplicate = session.pendingRecovery?.fingerprint === issue.fingerprint;
            if (!isDuplicate && session.retryCount < cfg.continuityMaxRetries) {
              session.pendingRecovery = issue;
              log(api, "warn", "continuity watchdog flagged incomplete turn", {
                sessionTag: session.sessionTag,
                kind: issue.kind,
                reason: issue.reason,
                retryCount: session.retryCount,
                maxRetries: cfg.continuityMaxRetries,
              });
            }
          } else if (assistantText.trim()) {
            session.pendingRecovery = null;
            session.retryCount = 0;
          }
        }
        if (!userPrompt.trim() || !assistantText.trim()) return null;

        if (session.storeInFlight) {
          log(api, "debug", "auto-store skipped; previous store still in flight", {
            sessionTag: session.sessionTag,
          });
          return null;
        }

        session.storeInFlight = true;
        void (async () => {
          try {
            let chunks = await extractMemoryChunksWithSidecar(cfg, userPrompt, assistantText);
            log(api, "info", "sidecar extraction result", {
              sessionTag: session.sessionTag,
              sidecarModel: cfg.sidecarModel,
              chunks: chunks.length,
            });
            if (chunks.length === 0) {
              chunks = heuristicMemoryChunks(userPrompt, assistantText, cfg.storeLimit);
              log(api, "warn", "sidecar extraction empty; using heuristic fallback", {
                sessionTag: session.sessionTag,
                heuristicChunks: chunks.length,
              });
            }
            log(api, "info", "auto-store extraction complete", {
              sessionTag: session.sessionTag,
              sidecarModel: cfg.sidecarModel,
              chunks: chunks.length,
            });
            if (chunks.length === 0) return;

            const storeOps = chunks.map((chunk, i) => {
              log(api, "info", "attempting memory store", {
                sessionTag: session.sessionTag,
                chunkType: chunk.chunkType,
                chunkPreview: truncate(chunk.content, 140),
                index: i,
              });
              return storeRlmChunk(cfg, session.sessionTag, chunk, i);
            });
            const results = await Promise.all(storeOps);
            const stored = results.filter(Boolean).length;
            log(api, "info", `stored ${stored}/${chunks.length} memory chunks`, {
              sessionTag: session.sessionTag,
              sidecarModel: cfg.sidecarModel,
              rlmMinScore: currentRlmMinScore(cfg),
              rlmGlobalTag: cfg.rlmGlobalTag,
            });
          } catch (error) {
            log(api, "warn", "agent_end auto-store async task failed", error);
          } finally {
            session.storeInFlight = false;
          }
        })();

        return null;
      } catch (error) {
        log(api, "warn", "agent_end auto-store failed", error);
        return null;
      }
    }, {
      name: "pi-context.agent-end",
      description: "Extract and store coding-session memory in YAMS after a completed turn",
    });
  }

  log(api, "info", "loaded", {
    enabledRlm: cfg.enabledRlm,
    enabledDcs: cfg.enabledDcs,
    yamsCwd: cfg.yamsCwd,
    rlmCollection: cfg.rlmCollection,
    rlmGlobalTag: cfg.rlmGlobalTag,
    rlmBaseMinScore: cfg.rlmBaseMinScore,
    rlmDynamicPolicy: cfg.rlmDynamicPolicy,
    autoStore: cfg.autoStore,
    storeLimit: cfg.storeLimit,
    continuityWatchdogEnabled: cfg.continuityWatchdogEnabled,
    continuityMaxRetries: cfg.continuityMaxRetries,
    continuityCooldownMs: cfg.continuityCooldownMs,
    activityHeartbeatEnabled: cfg.activityHeartbeatEnabled,
    activityHeartbeatMs: cfg.activityHeartbeatMs,
    activityHeartbeatPollMs: cfg.activityHeartbeatPollMs,
  });

  if (cfg.activityHeartbeatEnabled && typeof api?.registerService === "function") {
    api.registerService({
      id: "pi-context.activity-heartbeat",
      start: async (ctx: any) => {
        startHeartbeatLoop(api, cfg, sessions, ctx);
      },
      stop: async () => {
        stopHeartbeatLoop();
      },
    });
  } else if (cfg.activityHeartbeatEnabled) {
    log(api, "warn", "registerService unavailable; starting fallback activity heartbeat loop");
    startHeartbeatLoop(api, cfg, sessions);
  }
}
