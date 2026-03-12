import fs from "node:fs";
import path from "node:path";
import { homedir, tmpdir } from "node:os";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TRACE_FILE = process.env.PI_CONTEXT_CHUNKER_TRACE_FILE || `${homedir()}/.pi/agent/context-chunker.jsonl`;
const TRACE_ENABLED = parseBoolean(process.env.PI_CONTEXT_CHUNKER_TRACE_ENABLED, true);

// YAMS collection / tag constants (compatible with hybrid-optimizer RLM)
const CHUNK_COLLECTION = process.env.PI_CHUNK_COLLECTION || "pi-session-memory";
const CHUNK_STORE_TAGS = "rlm,pi-session-memory";
const CHUNK_STORE_TIMEOUT_MS = parsePositiveInt(process.env.PI_CHUNK_STORE_TIMEOUT_MS, 10000);
const CHUNK_RETRIEVE_TIMEOUT_MS = parsePositiveInt(process.env.PI_CHUNK_RETRIEVE_TIMEOUT_MS, 8000);
const CHUNK_RETRIEVE_LIMIT = parsePositiveInt(process.env.PI_CHUNK_RETRIEVE_LIMIT, 6);
const CHUNK_MIN_SCORE = 0.003;
const CHUNK_SEARCH_SIMILARITY = process.env.PI_CHUNK_SEARCH_SIMILARITY || "0.001";
const CHUNK_MAX_CHARS = parsePositiveInt(process.env.PI_CHUNK_MAX_CHARS, 2000);

// Chunking behavior
const CHUNK_MAX_PER_TURN = parsePositiveInt(process.env.PI_CHUNK_MAX_PER_TURN, 8);
const CHUNK_MIN_TEXT_CHARS = parsePositiveInt(process.env.PI_CHUNK_MIN_TEXT_CHARS, 60);

// Granularity escalation — at higher token pressure, extract more chunks
const CHUNK_HIGH_PRESSURE_TOKENS = parsePositiveInt(process.env.PI_CHUNK_HIGH_PRESSURE_TOKENS, 128000);
const CHUNK_HIGH_PRESSURE_MAX_PER_TURN = parsePositiveInt(process.env.PI_CHUNK_HIGH_PRESSURE_MAX, 12);

// Context builder: how many retrieved chunks to inject as synthetic messages
const CTX_MAX_INJECTED_CHUNKS = parsePositiveInt(process.env.PI_CTX_MAX_INJECTED_CHUNKS, 5);
const CTX_MAX_CHUNK_INJECT_CHARS = parsePositiveInt(process.env.PI_CTX_MAX_CHUNK_INJECT_CHARS, 1200);

// ---------------------------------------------------------------------------
// Utility helpers (self-contained)
// ---------------------------------------------------------------------------

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const c of content) {
    if (typeof c === "string") {
      out.push(c);
      continue;
    }
    if (!c || typeof c !== "object") continue;
    if (typeof c.text === "string") out.push(c.text);
    if (typeof c.content === "string") out.push(c.content);
  }
  return out.join("\n");
}

function trace(type: string, payload: Record<string, unknown> = {}): void {
  if (!TRACE_ENABLED) return;
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), type, ...payload });
    fs.appendFileSync(TRACE_FILE, `${line}\n`, "utf-8");
  } catch {
    // Ignore trace write errors.
  }
}

// ---------------------------------------------------------------------------
// Deferred temp file cleanup — prevents race with async YAMS ingest
// ---------------------------------------------------------------------------

/** How long to keep temp files before sweeping (15 min). */
const DEFERRED_TTL_MS = 15 * 60 * 1000;
/** Maximum number of pending temp files before forced eviction. */
const DEFERRED_MAX_FILES = 200;

type DeferredFile = { path: string; createdAt: number };

/**
 * Manages deferred cleanup of temp files written for YAMS ingest.
 *
 * `yams add` is async — it enqueues a document and returns immediately.
 * The daemon's IngestService processes the queue later and reads the file
 * from disk. If we `unlinkSync` the temp file in a `finally` block right
 * after `exec("yams", ["add", ...])` returns, the daemon may find the file
 * already deleted.
 *
 * Instead, temp files are registered here and cleaned up:
 * - Periodically (files older than DEFERRED_TTL_MS) via `sweep()`
 * - On session_shutdown via `flushAll()`
 * - When the pending count exceeds DEFERRED_MAX_FILES (oldest evicted)
 */
class TempFileManager {
  private _pending: DeferredFile[] = [];

  /** Register a temp file for deferred cleanup. */
  register(filePath: string, now?: number): void {
    this._pending.push({ path: filePath, createdAt: now ?? Date.now() });
    // If we exceed the bound, evict oldest files immediately
    while (this._pending.length > DEFERRED_MAX_FILES) {
      const oldest = this._pending.shift()!;
      try {
        fs.unlinkSync(oldest.path);
      } catch {
        // Already gone or inaccessible — fine.
      }
    }
  }

  /** Sweep files older than TTL. Returns count of files removed. */
  sweep(now?: number): number {
    const cutoff = (now ?? Date.now()) - DEFERRED_TTL_MS;
    let removed = 0;
    const remaining: DeferredFile[] = [];

    for (const entry of this._pending) {
      if (entry.createdAt < cutoff) {
        try {
          fs.unlinkSync(entry.path);
        } catch {
          // Already gone — fine.
        }
        removed++;
      } else {
        remaining.push(entry);
      }
    }

    this._pending = remaining;
    return removed;
  }

  /** Flush all pending files (called on session_shutdown). */
  flushAll(): number {
    let removed = 0;
    for (const entry of this._pending) {
      try {
        fs.unlinkSync(entry.path);
        removed++;
      } catch {
        // Already gone — fine.
      }
    }
    this._pending = [];
    return removed;
  }

  get pendingCount(): number {
    return this._pending.length;
  }
}

/** Module-level temp file manager for the semantic compressor. */
const tempFileManager = new TempFileManager();

// ---------------------------------------------------------------------------
// Query text sanitization helpers
// ---------------------------------------------------------------------------

/** Strip wrapper/meta tags that leak from LLM output into queries. */
function stripWrapperTags(text: string): string {
  // Remove matched pairs first (tag + content between them)
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "");
  text = text.replace(/<antThinking>[\s\S]*?<\/antThinking>/gi, "");
  text = text.replace(/<reflection>[\s\S]*?<\/reflection>/gi, "");
  text = text.replace(/<scratchpad>[\s\S]*?<\/scratchpad>/gi, "");
  text = text.replace(/<internal>[\s\S]*?<\/internal>/gi, "");
  // Remove orphaned opening tags and everything after them (content is likely internal)
  text = text.replace(/<(?:think|system-reminder|antThinking|reflection|scratchpad|internal)(?:\s[^>]*)?>[\s\S]*/gi, "");
  // Remove orphaned closing tags
  text = text.replace(/<\/(?:think|system-reminder|antThinking|reflection|scratchpad|internal)(?:\s[^>]*)?>/gi, "");
  // Remove any remaining angle-bracket tag-like patterns that are clearly not content
  // (e.g., <foo_bar> but NOT mathematical expressions like "x < 5")
  text = text.replace(/<\/?[a-zA-Z_][\w-]*(?:\s[^>]*)?>/g, "");
  return text;
}

/** Collapse whitespace, strip control characters. */
function sanitizeQueryText(text: string): string {
  // Remove control characters (except newline/tab which are whitespace)
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  // Collapse all whitespace to single spaces
  text = text.replace(/\s+/g, " ");
  return text.trim();
}

// ---------------------------------------------------------------------------
// Chunk types — extends the original RLM types
// ---------------------------------------------------------------------------

/** All recognized chunk types for proactive context chunking. */
type ChunkType =
  | "objective"
  | "user-request"
  | "assistant-finding"
  | "file-context"
  | "tool-outcome"
  | "code-change"
  | "decision";

type ContextChunk = {
  type: ChunkType;
  content: string;
};

/** A chunk retrieved from YAMS with score metadata. */
type RetrievedChunk = {
  snippet: string;
  score: number;
  chunkType: string;
};

// ---------------------------------------------------------------------------
// Message serialization (kept from original — useful for chunk content)
// ---------------------------------------------------------------------------

function serializeMessages(messages: any[], charBudget: number): string {
  const parts: string[] = [];
  let used = 0;

  for (const msg of messages) {
    if (used >= charBudget) break;

    const role = msg?.role || "unknown";
    let text = "";

    if (role === "user") {
      text = extractText(msg?.content);
    } else if (role === "assistant") {
      const content = msg?.content;
      if (Array.isArray(content)) {
        const textParts: string[] = [];
        const toolCalls: string[] = [];
        for (const block of content) {
          if (block?.type === "text" && typeof block.text === "string") {
            textParts.push(block.text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim());
          } else if (block?.type === "toolCall" && block.name) {
            const args = block.arguments || {};
            const argsStr = Object.entries(args)
              .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
              .join(", ");
            toolCalls.push(`${block.name}(${truncate(argsStr, 200)})`);
          }
        }
        if (textParts.length > 0) text += textParts.join("\n");
        if (toolCalls.length > 0) text += `\n[tool calls]: ${toolCalls.join("; ")}`;
      } else {
        text = extractText(content);
      }
    } else if (role === "toolResult") {
      const content = extractText(msg?.content);
      text = content ? truncate(content, 800) : "";
    }

    if (!text || text.trim().length < 20) continue;

    const entry = `[${role}]: ${text}`;
    const remaining = charBudget - used;
    if (entry.length > remaining) {
      parts.push(truncate(entry, remaining));
      break;
    }
    parts.push(entry);
    used += entry.length + 2; // +2 for \n\n separator
  }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Heuristic chunk extraction from conversation messages
// ---------------------------------------------------------------------------

/**
 * Extract file paths from text (same regex as hybrid-optimizer.ts).
 */
function extractFilePaths(text: string): string[] {
  const regex = /(?:\/[\w./-]+(?:\.\w{1,10}))|(?:[\w./-]+\/[\w./-]+(?:\.\w{1,10}))/g;
  const matches = text.match(regex) || [];
  return [...new Set(matches)]
    .filter((p) => !p.startsWith("/tmp/") && !p.includes("/node_modules/") && p.length < 200)
    .slice(0, 25);
}

/**
 * Detect code change patterns in text.
 */
function detectCodeChanges(text: string): string[] {
  const patterns: string[] = [];
  // File creation/modification
  const fileOps = text.match(/(?:created?|modified?|updated?|wrote|deleted?|renamed?)\s+(?:file\s+)?["'`]?([/\w.-]+\.\w{1,10})["'`]?/gi);
  if (fileOps) patterns.push(...fileOps.slice(0, 5));
  // Diff-like patterns
  const diffs = text.match(/^[+-]{1,3}\s+.{20,}/gm);
  if (diffs) patterns.push(`${diffs.length} diff lines detected`);
  // Function/class definitions
  const defs = text.match(/(?:function|class|const|let|var|export|import)\s+\w+/g);
  if (defs) patterns.push(...defs.slice(0, 3).map((d) => `defined: ${d}`));
  return patterns;
}

/**
 * Detect decision patterns in text (assertions, choices, conclusions).
 */
function detectDecisions(text: string): string | null {
  const decisionMarkers = [
    /(?:decided|decision|choosing|chose|going with|will use|opted for|selected)\s+.{20,}/gi,
    /(?:because|since|therefore|thus|so we|the reason)\s+.{20,}/gi,
    /(?:instead of|rather than|over|prefer)\s+.{20,}/gi,
    /(?:the (?:root cause|issue|problem|bug|fix) (?:is|was))\s+.{10,}/gi,
  ];

  const found: string[] = [];
  for (const pattern of decisionMarkers) {
    const matches = text.match(pattern);
    if (matches) found.push(...matches.slice(0, 2));
  }

  if (found.length === 0) return null;
  const combined = found.join(" | ");
  return combined.length > CHUNK_MAX_CHARS
    ? `${combined.slice(0, CHUNK_MAX_CHARS - 3)}...`
    : combined;
}

/**
 * Extract structured chunks from the latest turn's messages.
 *
 * This is the core heuristic extractor. It scans messages for:
 * - User requests
 * - Assistant findings (conclusions, non-thinking text)
 * - Tool outcomes (tool results with meaningful content)
 * - Code changes (file operations detected in text)
 * - Decisions (reasoning patterns)
 * - File context (paths mentioned)
 *
 * @param messages - Messages from the latest turn (typically the last few messages)
 * @param maxChunks - Maximum chunks to extract
 */
function extractTurnChunks(messages: any[], maxChunks: number): ContextChunk[] {
  const chunks: ContextChunk[] = [];
  const allFilePaths: string[] = [];

  for (const msg of messages) {
    if (chunks.length >= maxChunks) break;

    const role = msg?.role;
    const rawText = extractText(msg?.content);
    if (!rawText || rawText.trim().length < CHUNK_MIN_TEXT_CHARS) continue;

    // Collect file paths from all messages
    allFilePaths.push(...extractFilePaths(rawText));

    if (role === "user") {
      // User request chunk
      const cleaned = rawText.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim();
      if (cleaned.length > 80 && cleaned.length < 6000) {
        chunks.push({
          type: "user-request",
          content: truncate(`User request: ${cleaned}`, CHUNK_MAX_CHARS),
        });
      }
    } else if (role === "assistant") {
      // Strip thinking blocks
      const withoutThinking = rawText.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      if (withoutThinking.length < CHUNK_MIN_TEXT_CHARS) continue;

      // Check for decisions
      const decisionText = detectDecisions(withoutThinking);
      if (decisionText && chunks.length < maxChunks) {
        chunks.push({
          type: "decision",
          content: truncate(`Decision: ${decisionText}`, CHUNK_MAX_CHARS),
        });
      }

      // Check for code changes
      const codeChanges = detectCodeChanges(withoutThinking);
      if (codeChanges.length > 0 && chunks.length < maxChunks) {
        chunks.push({
          type: "code-change",
          content: truncate(`Code changes: ${codeChanges.join("; ")}`, CHUNK_MAX_CHARS),
        });
      }

      // General assistant finding (conclusions)
      // Only if we didn't already capture a decision or code-change from this message
      if (chunks.length < maxChunks && withoutThinking.length > 120) {
        // Extract the first substantive paragraph as a finding
        const paragraphs = withoutThinking.split(/\n{2,}/).filter((p) => p.trim().length > 50);
        if (paragraphs.length > 0) {
          const finding = paragraphs.slice(0, 2).join(" ").trim();
          chunks.push({
            type: "assistant-finding",
            content: truncate(`Finding: ${finding}`, CHUNK_MAX_CHARS),
          });
        }
      }
    } else if (role === "toolResult") {
      // Tool outcome chunk — capture meaningful tool results
      const toolName = msg?.toolName || "unknown";
      // Skip very large tool outputs (they're noise) and very small ones
      if (rawText.length > 100 && rawText.length < 4000 && chunks.length < maxChunks) {
        chunks.push({
          type: "tool-outcome",
          content: truncate(`Tool ${toolName} result: ${rawText}`, CHUNK_MAX_CHARS),
        });
      }
    }
  }

  // File context chunk: consolidated paths
  const uniquePaths = [...new Set(allFilePaths)].slice(0, 20);
  if (uniquePaths.length > 0 && chunks.length < maxChunks) {
    chunks.push({
      type: "file-context",
      content: `Relevant files: ${uniquePaths.join(", ")}`,
    });
  }

  return chunks.slice(0, maxChunks);
}

// ---------------------------------------------------------------------------
// YAMS storage — write chunks to YAMS via temp file
// ---------------------------------------------------------------------------

/**
 * Store a single chunk in YAMS. Uses deferred cleanup instead of immediate
 * `unlinkSync` to avoid the race condition where `yams add` returns before
 * the daemon's IngestService reads the file from disk.
 */
async function storeChunk(
  pi: ExtensionAPI,
  name: string,
  content: string,
  metadata: string,
  sessionId: string,
): Promise<boolean> {
  const tmpFile = path.join(
    tmpdir(),
    `pi-chunk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
  );
  const tags = `${CHUNK_STORE_TAGS},session:${sessionId}`;
  try {
    fs.writeFileSync(tmpFile, content, "utf-8");
    const result = await pi.exec(
      "yams",
      [
        "add",
        tmpFile,
        "--name",
        name,
        "--collection",
        CHUNK_COLLECTION,
        "--tags",
        tags,
        "--metadata",
        metadata,
      ],
      { timeout: CHUNK_STORE_TIMEOUT_MS },
    );
    // Deferred cleanup — file stays alive for daemon to read
    tempFileManager.register(tmpFile);
    return result.code === 0;
  } catch {
    // On failure, still defer (the daemon might still be processing)
    tempFileManager.register(tmpFile);
    return false;
  }
}

/**
 * Store a batch of chunks in YAMS. Fire-and-forget safe.
 */
async function storeChunks(
  pi: ExtensionAPI,
  chunks: ContextChunk[],
  sessionId: string,
  turnNumber: number,
): Promise<{ stored: number; failed: number }> {
  let stored = 0;
  let failed = 0;

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const name = `pi-ctx-${sessionId}-t${turnNumber}-${chunk.type}-${i}`;
    const metadata = `chunk_type=${chunk.type},session_id=${sessionId},turn=${turnNumber}`;
    const ok = await storeChunk(pi, name, chunk.content, metadata, sessionId);
    if (ok) {
      stored += 1;
    } else {
      failed += 1;
    }
  }

  return { stored, failed };
}

// ---------------------------------------------------------------------------
// YAMS retrieval — search for relevant chunks
// ---------------------------------------------------------------------------

/**
 * Parse YAMS search results. Replicates `parseRlmSearchResults` from
 * hybrid-optimizer.ts.
 */
function parseSearchResults(
  stdout: string,
  seenIds: Set<string>,
): RetrievedChunk[] {
  try {
    const parsed = JSON.parse(stdout);
    const results: any[] = Array.isArray(parsed) ? parsed : parsed.results || [];
    const hints: RetrievedChunk[] = [];
    for (const r of results) {
      if (
        typeof r.score === "number" &&
        r.score >= CHUNK_MIN_SCORE &&
        typeof r.snippet === "string" &&
        r.snippet.length > 0
      ) {
        const dedupeKey = String(r.id || r.path || r.snippet.slice(0, 80));
        if (seenIds.has(dedupeKey)) continue;
        seenIds.add(dedupeKey);

        // Extract chunk type: prefer metadata, fall back to name/path pattern
        let chunkType = r.metadata?.chunk_type;
        if (!chunkType && typeof r.path === "string") {
          // Name pattern: pi-ctx-<session>-t<turn>-<type>-<idx>
          // Session IDs may contain hyphens, so anchor on -t<digit>-
          const pathMatch = r.path.match(/-t\d+-([\w][\w-]*)-\d+$/);
          if (pathMatch) chunkType = pathMatch[1];
        }

        hints.push({
          snippet: r.snippet.replace(/\s+/g, " ").trim(),
          score: r.score,
          chunkType: chunkType || "unknown",
        });
      }
    }
    return hints;
  } catch {
    return [];
  }
}

/**
 * Retrieve relevant chunks from YAMS. Two-phase:
 *   Phase 1: Session-scoped (current session memories)
 *   Phase 2: Global RLM (cross-session long-term memory)
 */
async function fetchRelevantChunks(
  pi: ExtensionAPI,
  query: string,
  sessionId: string,
  limit: number,
): Promise<RetrievedChunk[]> {
  if (!query.trim()) return [];

  const seenIds = new Set<string>();
  const allChunks: RetrievedChunk[] = [];

  // Phase 1: Session-scoped retrieval
  try {
    const sessionResult = await pi.exec(
      "yams",
      [
        "search",
        "--json",
        "--tags",
        `session:${sessionId}`,
        "--similarity",
        CHUNK_SEARCH_SIMILARITY,
        "--limit",
        String(limit + 2),
        query,
      ],
      { timeout: CHUNK_RETRIEVE_TIMEOUT_MS },
    );
    if (sessionResult.code === 0 && sessionResult.stdout) {
      const sessionChunks = parseSearchResults(sessionResult.stdout, seenIds);
      allChunks.push(...sessionChunks.slice(0, limit));
    }
  } catch {
    // Session-scoped search failed; continue to global phase.
  }

  // Phase 2: Global RLM retrieval
  const remaining = limit - allChunks.length;
  if (remaining > 0) {
    try {
      const globalResult = await pi.exec(
        "yams",
        [
          "search",
          "--json",
          "--tags",
          "rlm",
          "--similarity",
          CHUNK_SEARCH_SIMILARITY,
          "--limit",
          String(remaining + 2),
          query,
        ],
        { timeout: CHUNK_RETRIEVE_TIMEOUT_MS },
      );
      if (globalResult.code === 0 && globalResult.stdout) {
        const globalChunks = parseSearchResults(globalResult.stdout, seenIds);
        allChunks.push(...globalChunks.slice(0, remaining));
      }
    } catch {
      // Global search failed; return whatever session phase found.
    }
  }

  return allChunks.slice(0, limit);
}

/**
 * Build a query string from recent messages for YAMS retrieval.
 * Takes the most recent user message + assistant conclusions to form a
 * semantically rich query.
 *
 * Aggressively strips LLM wrapper tags (<think>, <system-reminder>, etc.)
 * that can leak into search queries and break FTS5 syntax parsing.
 */
function buildRetrievalQuery(messages: any[]): string {
  const parts: string[] = [];

  // Walk backwards from the end to find the latest user message and assistant text
  for (let i = messages.length - 1; i >= 0 && parts.length < 3; i--) {
    const msg = messages[i];
    const role = msg?.role;
    if (role === "user") {
      const text = stripWrapperTags(extractText(msg.content)).trim();
      if (text.length > 30) {
        parts.push(text.slice(0, 400));
      }
    } else if (role === "assistant") {
      const text = stripWrapperTags(extractText(msg.content)).trim();
      if (text.length > 50) {
        parts.push(text.slice(0, 300));
      }
    }
  }

  return sanitizeQueryText(parts.join(" ").slice(0, 900));
}

// ---------------------------------------------------------------------------
// ContextChunker — the exported singleton
// ---------------------------------------------------------------------------

class ContextChunker {
  /** Pre-fetched chunks ready for the context handler to inject. */
  private _cachedChunks: RetrievedChunk[] = [];
  /** Whether a chunking + store + fetch cycle is running. */
  private _inFlight = false;
  /** Session tracking. */
  private _sessionId: string = "";
  private _turnNumber = 0;
  /** Stats. */
  private _totalChunksStored = 0;
  private _totalStoreFailed = 0;
  private _totalRetrieved = 0;

  /**
   * Get the pre-fetched relevant chunks. The context handler in
   * hybrid-optimizer.ts calls this at Tier 2+ to build optimized context.
   */
  getCachedChunks(): RetrievedChunk[] {
    return this._cachedChunks;
  }

  /**
   * Build optimized context by replacing old messages with retrieved chunks.
   *
   * Given a full messages array, inserts synthetic summary messages at the
   * beginning (representing retrieved YAMS context) and keeps the last
   * `keepLastN` messages verbatim. Messages between the synthetic preamble
   * and the kept tail are dropped.
   *
   * If no cached chunks are available, returns the original array unchanged.
   */
  buildOptimizedContext(messages: any[], keepLastN: number): any[] {
    if (messages.length === 0 || this._cachedChunks.length === 0) return messages;

    const safeTail = Math.min(keepLastN, messages.length);
    const tailStart = messages.length - safeTail;

    // If there aren't enough old messages to justify replacing, return as-is
    if (tailStart <= 0) return messages;

    // Build synthetic preamble from cached chunks
    const preambleMessages: any[] = [];
    const usedChunks = this._cachedChunks.slice(0, CTX_MAX_INJECTED_CHUNKS);

    for (const chunk of usedChunks) {
      const snippetText = truncate(chunk.snippet, CTX_MAX_CHUNK_INJECT_CHARS);
      preambleMessages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `[retrieved context — ${chunk.chunkType} (score: ${chunk.score.toFixed(3)})]: ${snippetText}`,
          },
        ],
        timestamp: Date.now(),
      });
    }

    // Combine: preamble (retrieved chunks) + tail (recent messages)
    const result = [...preambleMessages, ...messages.slice(tailStart)];

    trace("build_optimized_context", {
      originalMessages: messages.length,
      resultMessages: result.length,
      preambleChunks: preambleMessages.length,
      tailMessages: safeTail,
      droppedMessages: tailStart - 0, // messages replaced by retrieval
    });

    return result;
  }

  /**
   * Invalidate cached chunks. Called after compaction resets message history.
   */
  invalidate(): void {
    const count = this._cachedChunks.length;
    this._cachedChunks = [];
    if (count > 0) {
      trace("cache_invalidated", { chunksCleared: count });
    }
  }

  /**
   * Return chunker statistics.
   */
  stats(): {
    cachedChunks: number;
    inFlight: boolean;
    sessionId: string;
    turnNumber: number;
    totalChunksStored: number;
    totalStoreFailed: number;
    totalRetrieved: number;
  } {
    return {
      cachedChunks: this._cachedChunks.length,
      inFlight: this._inFlight,
      sessionId: this._sessionId,
      turnNumber: this._turnNumber,
      totalChunksStored: this._totalChunksStored,
      totalStoreFailed: this._totalStoreFailed,
      totalRetrieved: this._totalRetrieved,
    };
  }

  // ---- Internal methods ----

  /** @internal */
  get inFlight(): boolean {
    return this._inFlight;
  }
  /** @internal */
  set inFlight(v: boolean) {
    this._inFlight = v;
  }

  /** @internal */
  get sessionId(): string {
    return this._sessionId;
  }

  /** @internal */
  get turnNumber(): number {
    return this._turnNumber;
  }

  /** @internal — set session ID */
  setSession(sessionId: string): void {
    this._sessionId = sessionId;
    this._turnNumber = 0;
  }

  /** @internal — increment turn counter */
  incrementTurn(): void {
    this._turnNumber++;
  }

  /** @internal — set cached chunks (after retrieval) */
  setCachedChunks(chunks: RetrievedChunk[]): void {
    this._cachedChunks = chunks;
  }

  /** @internal — record store results */
  recordStoreResult(stored: number, failed: number): void {
    this._totalChunksStored += stored;
    this._totalStoreFailed += failed;
  }

  /** @internal — record retrieval count */
  recordRetrieval(count: number): void {
    this._totalRetrieved += count;
  }

  /** @internal — Reset for testing */
  _reset(): void {
    this._cachedChunks = [];
    this._inFlight = false;
    this._sessionId = "";
    this._turnNumber = 0;
    this._totalChunksStored = 0;
    this._totalStoreFailed = 0;
    this._totalRetrieved = 0;
  }
}

/** Exported singleton — hybrid-optimizer.ts imports this */
export const contextChunker = new ContextChunker();

// ---------------------------------------------------------------------------
// Turn-end orchestration: extract → store → pre-fetch
// ---------------------------------------------------------------------------

/**
 * The main turn-end pipeline:
 * 1. Extract chunks from the latest turn's messages
 * 2. Store them in YAMS
 * 3. Pre-fetch relevant chunks for the NEXT context handler call
 */
async function processTurnEnd(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  messages: any[],
): Promise<void> {
  if (contextChunker.inFlight) {
    trace("turn_process_skipped", { reason: "already_in_flight" });
    return;
  }

  if (!messages || messages.length === 0) {
    trace("turn_process_skipped", { reason: "no_messages" });
    return;
  }

  const sessionId = contextChunker.sessionId;
  if (!sessionId) {
    trace("turn_process_skipped", { reason: "no_session" });
    return;
  }

  contextChunker.incrementTurn();
  const turnNumber = contextChunker.turnNumber;

  // Determine chunk budget based on token pressure
  const usage = ctx.getContextUsage();
  const tokens = usage?.tokens ?? 0;
  const maxChunks = tokens >= CHUNK_HIGH_PRESSURE_TOKENS
    ? CHUNK_HIGH_PRESSURE_MAX_PER_TURN
    : CHUNK_MAX_PER_TURN;

  // Step 1: Extract chunks from recent messages (last turn only)
  // We look at the last ~10 messages as a proxy for "this turn"
  const recentSlice = messages.slice(Math.max(0, messages.length - 10));
  const chunks = extractTurnChunks(recentSlice, maxChunks);

  if (chunks.length === 0) {
    trace("turn_process_no_chunks", { turnNumber, recentMessages: recentSlice.length });
    return;
  }

  contextChunker.inFlight = true;
  try {
    trace("turn_process_start", {
      turnNumber,
      tokens,
      maxChunks,
      extractedChunks: chunks.length,
      chunkTypes: chunks.map((c) => c.type),
    });

    // Step 2: Store chunks in YAMS
    const { stored, failed } = await storeChunks(pi, chunks, sessionId, turnNumber);
    contextChunker.recordStoreResult(stored, failed);

    trace("turn_chunks_stored", {
      turnNumber,
      stored,
      failed,
      totalStored: contextChunker.stats().totalChunksStored,
    });

    // Step 3: Pre-fetch relevant chunks for the next context handler call
    const query = buildRetrievalQuery(messages);
    if (query.trim()) {
      const retrieved = await fetchRelevantChunks(
        pi,
        query,
        sessionId,
        CHUNK_RETRIEVE_LIMIT,
      );
      contextChunker.setCachedChunks(retrieved);
      contextChunker.recordRetrieval(retrieved.length);

      trace("turn_chunks_prefetched", {
        turnNumber,
        queryChars: query.length,
        retrievedChunks: retrieved.length,
        chunkTypes: retrieved.map((c) => c.chunkType),
      });
    }
  } catch (err: any) {
    trace("turn_process_error", {
      turnNumber,
      error: String(err).slice(0, 500),
    });
  } finally {
    contextChunker.inFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Module-level state for message tracking
// ---------------------------------------------------------------------------

/**
 * Snapshot of the most recent messages array from the context handler.
 * Updated each time the context event fires. The turn_end handler reads
 * this to identify content for chunking.
 */
let currentMessages: any[] | null = null;

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function contextChunkerExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (event, _ctx) => {
    contextChunker._reset();
    currentMessages = null;
    // Use session ID if available from event, otherwise generate one
    const sessionId = (event as any)?.sessionId
      || `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    contextChunker.setSession(sessionId);
    trace("session_start", { sessionId });
  });

  /**
   * Context event handler — lightweight snapshot only.
   *
   * This handler does NOT modify messages. Its sole job is to snapshot the
   * current messages array so the turn_end handler can extract chunks.
   *
   * IMPORTANT: We do NOT return { messages } — that would conflict with
   * hybrid-optimizer.ts's context handler.
   */
  pi.on("context", async (event, _ctx) => {
    const messages = (event as any).messages;
    if (Array.isArray(messages) && messages.length > 0) {
      currentMessages = messages;
    }
    // Return nothing — don't modify messages from this handler
  });

  /**
   * Turn-end handler — extract chunks, store in YAMS, pre-fetch.
   *
   * Runs every turn to proactively build the YAMS chunk store.
   * Increases extraction granularity at higher token pressure.
   */
  pi.on("turn_end", async (_event, ctx) => {
    if (!currentMessages || currentMessages.length === 0) return;
    // Sweep stale temp files (older than TTL) to prevent accumulation
    const swept = tempFileManager.sweep();
    if (swept > 0) {
      trace("temp_file_sweep", { removed: swept, remaining: tempFileManager.pendingCount });
    }
    try {
      await processTurnEnd(pi, ctx, currentMessages);
    } catch (err: any) {
      trace("turn_end_error", { error: String(err).slice(0, 500) });
    }
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    const stats = contextChunker.stats();
    // Flush all remaining temp files on session end
    const flushed = tempFileManager.flushAll();
    trace("session_shutdown", { ...stats, tempFilesFlushed: flushed });
    contextChunker._reset();
    currentMessages = null;
  });
}
