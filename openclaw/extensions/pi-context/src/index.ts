import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildRecoveryContext, detectContinuityIssue, shouldUseRecovery } from "./continuity.mjs";

const execFileAsync = promisify(execFile);

const DEFAULTS = {
  enabledRlm: true,
  enabledDcs: false,
  yamsBinary: "yams",
  yamsCwd: "/workspace/dotfiles",
  rlmCollection: "pi-session-memory",
  rlmSimilarity: 0.001,
  rlmLimit: 3,
  autoStore: true,
  storeLimit: 3,
  continuityWatchdogEnabled: true,
  continuityMaxRetries: 1,
  continuityCooldownMs: 120000,
  lmstudioBaseUrl: "http://host.docker.internal:1234/v1",
  sidecarModel: "qwen_qwen3.5-4b",
  dcsCli: "research-agent",
  dcsContextProfile: "small",
} as const;

const RLM_MIN_SCORE = 0.003;
const RLM_RETRIEVE_TIMEOUT_MS = 8000;
const SIDECAR_QUERY_TIMEOUT_MS = 12000;
const RLM_STORE_TIMEOUT_MS = 10000;

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
};

type PluginConfig = {
  enabledRlm: boolean;
  enabledDcs: boolean;
  yamsBinary: string;
  yamsCwd: string;
  rlmCollection: string;
  rlmSimilarity: number;
  rlmLimit: number;
  autoStore: boolean;
  storeLimit: number;
  continuityWatchdogEnabled: boolean;
  continuityMaxRetries: number;
  continuityCooldownMs: number;
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
  retryCount: number;
  lastRecoveryAt: number;
  pendingRecovery: null | {
    reason: string;
    kind: string;
    prompt: string;
    assistantText: string;
    fingerprint: string;
  };
};

type MemoryChunk = {
  chunkType: string;
  content: string;
};

function getPluginConfig(api: PluginApi): PluginConfig {
  const raw = api?.config?.plugins?.entries?.["pi-context"]?.config ?? {};
  return {
    enabledRlm: raw.enabledRlm ?? DEFAULTS.enabledRlm,
    enabledDcs: raw.enabledDcs ?? DEFAULTS.enabledDcs,
    yamsBinary: String(raw.yamsBinary ?? DEFAULTS.yamsBinary),
    yamsCwd: String(raw.yamsCwd ?? DEFAULTS.yamsCwd),
    rlmCollection: String(raw.rlmCollection ?? DEFAULTS.rlmCollection),
    rlmSimilarity: Number(raw.rlmSimilarity ?? DEFAULTS.rlmSimilarity),
    rlmLimit: Number(raw.rlmLimit ?? DEFAULTS.rlmLimit),
    autoStore: raw.autoStore ?? DEFAULTS.autoStore,
    storeLimit: Number(raw.storeLimit ?? DEFAULTS.storeLimit),
    continuityWatchdogEnabled: raw.continuityWatchdogEnabled ?? DEFAULTS.continuityWatchdogEnabled,
    continuityMaxRetries: Number(raw.continuityMaxRetries ?? DEFAULTS.continuityMaxRetries),
    continuityCooldownMs: Number(raw.continuityCooldownMs ?? DEFAULTS.continuityCooldownMs),
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

function parseSearchResults(stdout: string, seen: Set<string>): RlmHint[] {
  try {
    const parsed = JSON.parse(stdout);
    const results = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.results) ? parsed.results : [];
    const hints: RlmHint[] = [];
    for (const row of results) {
      if (typeof row?.score !== "number" || row.score < RLM_MIN_SCORE) continue;
      if (typeof row?.snippet !== "string" || !row.snippet.trim()) continue;
      const id = String(row?.id || row?.path || row?.snippet.slice(0, 80));
      if (seen.has(id)) continue;
      seen.add(id);
      hints.push({
        id,
        snippet: normalizeText(row.snippet),
        score: row.score,
        chunkType: String(row?.metadata?.chunk_type || "unknown"),
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
      hints.push(...parseSearchResults(sessionResult.stdout, seen).slice(0, cfg.rlmLimit));
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
      "rlm",
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
      hints.push(...parseSearchResults(globalResult.stdout, seen).slice(0, remaining));
    }
  }

  return hints.slice(0, cfg.rlmLimit);
}

async function storeRlmChunk(cfg: PluginConfig, sessionTag: string, chunk: MemoryChunk, index: number): Promise<boolean> {
  const tmpFile = path.join(os.tmpdir(), `pi-context-rlm-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}.txt`);
  const normalized = normalizeText(chunk.content);
  if (!normalized) return false;
  await fs.writeFile(tmpFile, normalized, "utf8");
  const name = `openclaw-rlm-${Date.now().toString(36)}-${chunk.chunkType}-${index}`;
  const metadata = `chunk_type=${chunk.chunkType},source=openclaw`;
  const tags = `rlm,pi-session-memory,${sessionTag}`;
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
      });
    }
    return result.code === 0;
  } finally {
    await fs.unlink(tmpFile).catch(() => undefined);
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
      retryCount: 0,
      lastRecoveryAt: 0,
      pendingRecovery: null,
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
        `Session tag: ${session.sessionTag}`,
        `Session key: ${sessionKey}`,
        `Tracked sessions: ${sessions.size}`,
        `Continuity watchdog: ${cfg.continuityWatchdogEnabled}`,
        `Continuity retries used: ${session.retryCount}/${cfg.continuityMaxRetries}`,
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
            `  pendingRecovery=${session.pendingRecovery ? session.pendingRecovery.kind : "none"}`,
            `  lastRecoveryAt=${formatTimestamp(session.lastRecoveryAt)}`,
          ].join("\n")
        );
      }
      return replyOrReturn(ctx, lines.join("\n"));
    },
  });

  if (cfg.enabledRlm) {
    registerHook(api, "before_prompt_build", async (payload: any) => {
      try {
        const prompt = extractPrompt(payload);
        const sessionKey = getSessionKey(payload);
        const session = ensureSession(sessionKey);
        log(api, "debug", "before_prompt_build received payload", {
          sessionKey,
          hasPrompt: Boolean(prompt.trim()),
          messageCount: Array.isArray(payload?.messages) ? payload.messages.length : 0,
          payloadKeys: Object.keys(payload || {}).slice(0, 20),
        });
        if (!prompt.trim()) return null;
        const refinedQuery = await refineQueryWithSidecar(cfg, prompt);
        log(api, "info", "recall query built", {
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
        log(api, "info", "recall search complete", {
          sessionKey,
          sessionTag: session.sessionTag,
          yamsCwd: cfg.yamsCwd,
          hits: hints.length,
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
        log(api, "warn", "before_prompt_build recall failed", error);
        return null;
      }
    }, {
      name: "pi-context.before-prompt-build",
      description: "Inject YAMS-based recalled context before prompt assembly",
    });
  }

  if (cfg.enabledRlm && cfg.autoStore) {
    registerHook(api, "agent_end", async (payload: any) => {
      try {
        const sessionKey = getSessionKey(payload);
        const session = ensureSession(sessionKey);
        const userPrompt = findLatestMessageText(payload, "user") || session.lastRawPrompt;
        const assistantText = findLatestMessageText(payload, "assistant");
        log(api, "debug", "agent_end received payload", {
          sessionKey,
          hasUserPrompt: Boolean(userPrompt.trim()),
          hasAssistantText: Boolean(assistantText.trim()),
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

        const chunks = await extractMemoryChunksWithSidecar(cfg, userPrompt, assistantText);
        log(api, "info", "auto-store extraction complete", {
          sessionTag: session.sessionTag,
          sidecarModel: cfg.sidecarModel,
          chunks: chunks.length,
        });
        if (chunks.length === 0) return null;

        let stored = 0;
        for (let i = 0; i < chunks.length; i += 1) {
          const ok = await storeRlmChunk(cfg, session.sessionTag, chunks[i], i);
          if (ok) stored += 1;
        }

        log(api, "info", `stored ${stored}/${chunks.length} memory chunks`, {
          sessionTag: session.sessionTag,
          sidecarModel: cfg.sidecarModel,
        });
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
    autoStore: cfg.autoStore,
    storeLimit: cfg.storeLimit,
    continuityWatchdogEnabled: cfg.continuityWatchdogEnabled,
    continuityMaxRetries: cfg.continuityMaxRetries,
    continuityCooldownMs: cfg.continuityCooldownMs,
  });
}
