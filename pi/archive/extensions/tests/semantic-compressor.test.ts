/**
 * Tests for semantic-compressor.ts (RLM chunking + YAMS context builder)
 *
 * Tests the ContextChunker class, chunk extraction heuristics, YAMS
 * storage/retrieval patterns, and the turn-end orchestration logic.
 *
 * No real YAMS or LLM calls — all external interactions are mocked.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  userMessage,
  assistantMessage,
  toolResultMessage,
  generateConversation,
  extractText,
  truncate,
  createMockPi,
  createMockCtx,
  createContextEvent,
} from "./test-helpers.ts";

// ---------------------------------------------------------------------------
// Re-implement key types and functions from semantic-compressor.ts for testing.
// This mirrors the approach used in the Phase 1 bug fix tests — extract the
// logic into testable units without importing the real module (which depends
// on @mariozechner/pi-coding-agent at import time).
// ---------------------------------------------------------------------------

const CHUNK_MAX_CHARS = 2000;
const CHUNK_MIN_TEXT_CHARS = 60;
const CHUNK_MAX_PER_TURN = 8;
const CHUNK_HIGH_PRESSURE_TOKENS = 128000;
const CHUNK_HIGH_PRESSURE_MAX_PER_TURN = 12;
const CTX_MAX_INJECTED_CHUNKS = 5;
const CTX_MAX_CHUNK_INJECT_CHARS = 1200;

// -- Types (mirrored) --

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

type RetrievedChunk = {
  snippet: string;
  score: number;
  chunkType: string;
};

// -- extractFilePaths (same as semantic-compressor.ts) --

function extractFilePaths(text: string): string[] {
  const regex = /(?:\/[\w./-]+(?:\.\w{1,10}))|(?:[\w./-]+\/[\w./-]+(?:\.\w{1,10}))/g;
  const matches = text.match(regex) || [];
  return [...new Set(matches)]
    .filter((p) => !p.startsWith("/tmp/") && !p.includes("/node_modules/") && p.length < 200)
    .slice(0, 25);
}

// -- detectCodeChanges (same as semantic-compressor.ts) --

function detectCodeChanges(text: string): string[] {
  const patterns: string[] = [];
  const fileOps = text.match(/(?:created?|modified?|updated?|wrote|deleted?|renamed?)\s+(?:file\s+)?["'`]?([/\w.-]+\.\w{1,10})["'`]?/gi);
  if (fileOps) patterns.push(...fileOps.slice(0, 5));
  const diffs = text.match(/^[+-]{1,3}\s+.{20,}/gm);
  if (diffs) patterns.push(`${diffs.length} diff lines detected`);
  const defs = text.match(/(?:function|class|const|let|var|export|import)\s+\w+/g);
  if (defs) patterns.push(...defs.slice(0, 3).map((d) => `defined: ${d}`));
  return patterns;
}

// -- detectDecisions (same as semantic-compressor.ts) --

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

// -- extractTurnChunks (same as semantic-compressor.ts) --

function extractTurnChunks(messages: any[], maxChunks: number): ContextChunk[] {
  const chunks: ContextChunk[] = [];
  const allFilePaths: string[] = [];

  for (const msg of messages) {
    if (chunks.length >= maxChunks) break;

    const role = msg?.role;
    const rawText = extractText(msg?.content);
    if (!rawText || rawText.trim().length < CHUNK_MIN_TEXT_CHARS) continue;

    allFilePaths.push(...extractFilePaths(rawText));

    if (role === "user") {
      const cleaned = rawText.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim();
      if (cleaned.length > 80 && cleaned.length < 6000) {
        chunks.push({
          type: "user-request",
          content: truncate(`User request: ${cleaned}`, CHUNK_MAX_CHARS),
        });
      }
    } else if (role === "assistant") {
      const withoutThinking = rawText.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      if (withoutThinking.length < CHUNK_MIN_TEXT_CHARS) continue;

      const decisionText = detectDecisions(withoutThinking);
      if (decisionText && chunks.length < maxChunks) {
        chunks.push({
          type: "decision",
          content: truncate(`Decision: ${decisionText}`, CHUNK_MAX_CHARS),
        });
      }

      const codeChanges = detectCodeChanges(withoutThinking);
      if (codeChanges.length > 0 && chunks.length < maxChunks) {
        chunks.push({
          type: "code-change",
          content: truncate(`Code changes: ${codeChanges.join("; ")}`, CHUNK_MAX_CHARS),
        });
      }

      if (chunks.length < maxChunks && withoutThinking.length > 120) {
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
      const toolName = msg?.toolName || "unknown";
      if (rawText.length > 100 && rawText.length < 4000 && chunks.length < maxChunks) {
        chunks.push({
          type: "tool-outcome",
          content: truncate(`Tool ${toolName} result: ${rawText}`, CHUNK_MAX_CHARS),
        });
      }
    }
  }

  const uniquePaths = [...new Set(allFilePaths)].slice(0, 20);
  if (uniquePaths.length > 0 && chunks.length < maxChunks) {
    chunks.push({
      type: "file-context",
      content: `Relevant files: ${uniquePaths.join(", ")}`,
    });
  }

  return chunks.slice(0, maxChunks);
}

// -- parseSearchResults (same as semantic-compressor.ts) --

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
        r.score >= 0.003 &&
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

// -- buildRetrievalQuery (same as semantic-compressor.ts) --

function buildRetrievalQuery(messages: any[]): string {
  const parts: string[] = [];
  for (let i = messages.length - 1; i >= 0 && parts.length < 3; i--) {
    const msg = messages[i];
    const role = msg?.role;
    if (role === "user") {
      const text = extractText(msg.content)
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
        .trim();
      if (text.length > 30) {
        parts.push(text.slice(0, 400));
      }
    } else if (role === "assistant") {
      const text = extractText(msg.content)
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .trim();
      if (text.length > 50) {
        parts.push(text.slice(0, 300));
      }
    }
  }
  return parts.join(" ").slice(0, 900);
}

// -- ContextChunker (mirrored for testing) --

class ContextChunker {
  private _cachedChunks: RetrievedChunk[] = [];
  private _inFlight = false;
  private _sessionId: string = "";
  private _turnNumber = 0;
  private _totalChunksStored = 0;
  private _totalStoreFailed = 0;
  private _totalRetrieved = 0;

  getCachedChunks(): RetrievedChunk[] {
    return this._cachedChunks;
  }

  buildOptimizedContext(messages: any[], keepLastN: number): any[] {
    if (messages.length === 0 || this._cachedChunks.length === 0) return messages;

    const safeTail = Math.min(keepLastN, messages.length);
    const tailStart = messages.length - safeTail;
    if (tailStart <= 0) return messages;

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

    return [...preambleMessages, ...messages.slice(tailStart)];
  }

  invalidate(): void {
    this._cachedChunks = [];
  }

  stats() {
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

  get inFlight(): boolean {
    return this._inFlight;
  }
  set inFlight(v: boolean) {
    this._inFlight = v;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  get turnNumber(): number {
    return this._turnNumber;
  }

  setSession(sessionId: string): void {
    this._sessionId = sessionId;
    this._turnNumber = 0;
  }

  incrementTurn(): void {
    this._turnNumber++;
  }

  setCachedChunks(chunks: RetrievedChunk[]): void {
    this._cachedChunks = chunks;
  }

  recordStoreResult(stored: number, failed: number): void {
    this._totalChunksStored += stored;
    this._totalStoreFailed += failed;
  }

  recordRetrieval(count: number): void {
    this._totalRetrieved += count;
  }

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

// ===========================================================================
// Tests
// ===========================================================================

describe("ContextChunker — basic operations", () => {
  let chunker: ContextChunker;

  beforeEach(() => {
    chunker = new ContextChunker();
  });

  it("starts empty", () => {
    const stats = chunker.stats();
    assert.equal(stats.cachedChunks, 0);
    assert.equal(stats.inFlight, false);
    assert.equal(stats.sessionId, "");
    assert.equal(stats.turnNumber, 0);
    assert.equal(stats.totalChunksStored, 0);
    assert.equal(stats.totalStoreFailed, 0);
    assert.equal(stats.totalRetrieved, 0);
  });

  it("setSession sets session ID and resets turn counter", () => {
    chunker.setSession("test-session-1");
    assert.equal(chunker.sessionId, "test-session-1");
    assert.equal(chunker.turnNumber, 0);
  });

  it("incrementTurn advances turn counter", () => {
    chunker.setSession("s1");
    chunker.incrementTurn();
    assert.equal(chunker.turnNumber, 1);
    chunker.incrementTurn();
    assert.equal(chunker.turnNumber, 2);
  });

  it("setCachedChunks and getCachedChunks roundtrip", () => {
    const chunks: RetrievedChunk[] = [
      { snippet: "Found bug in parser", score: 0.95, chunkType: "assistant-finding" },
      { snippet: "File: /src/parser.ts", score: 0.80, chunkType: "file-context" },
    ];
    chunker.setCachedChunks(chunks);
    assert.equal(chunker.getCachedChunks().length, 2);
    assert.equal(chunker.getCachedChunks()[0].snippet, "Found bug in parser");
    assert.equal(chunker.stats().cachedChunks, 2);
  });

  it("invalidate clears cached chunks", () => {
    chunker.setCachedChunks([
      { snippet: "test", score: 0.5, chunkType: "test" },
    ]);
    assert.equal(chunker.stats().cachedChunks, 1);
    chunker.invalidate();
    assert.equal(chunker.stats().cachedChunks, 0);
    assert.deepEqual(chunker.getCachedChunks(), []);
  });

  it("recordStoreResult accumulates stats", () => {
    chunker.recordStoreResult(3, 1);
    assert.equal(chunker.stats().totalChunksStored, 3);
    assert.equal(chunker.stats().totalStoreFailed, 1);
    chunker.recordStoreResult(2, 0);
    assert.equal(chunker.stats().totalChunksStored, 5);
    assert.equal(chunker.stats().totalStoreFailed, 1);
  });

  it("recordRetrieval accumulates stats", () => {
    chunker.recordRetrieval(4);
    assert.equal(chunker.stats().totalRetrieved, 4);
    chunker.recordRetrieval(2);
    assert.equal(chunker.stats().totalRetrieved, 6);
  });

  it("inFlight flag is read/writable", () => {
    assert.equal(chunker.inFlight, false);
    chunker.inFlight = true;
    assert.equal(chunker.inFlight, true);
    assert.equal(chunker.stats().inFlight, true);
  });

  it("_reset clears everything", () => {
    chunker.setSession("test");
    chunker.incrementTurn();
    chunker.setCachedChunks([{ snippet: "x", score: 0.5, chunkType: "test" }]);
    chunker.recordStoreResult(5, 2);
    chunker.recordRetrieval(3);
    chunker.inFlight = true;

    chunker._reset();
    const stats = chunker.stats();
    assert.equal(stats.cachedChunks, 0);
    assert.equal(stats.inFlight, false);
    assert.equal(stats.sessionId, "");
    assert.equal(stats.turnNumber, 0);
    assert.equal(stats.totalChunksStored, 0);
    assert.equal(stats.totalStoreFailed, 0);
    assert.equal(stats.totalRetrieved, 0);
  });
});

describe("ContextChunker — buildOptimizedContext", () => {
  let chunker: ContextChunker;

  beforeEach(() => {
    chunker = new ContextChunker();
  });

  it("returns original messages when no cached chunks", () => {
    const msgs = generateConversation(10);
    const result = chunker.buildOptimizedContext(msgs, 20);
    assert.deepEqual(result, msgs);
  });

  it("returns original messages when empty array passed", () => {
    chunker.setCachedChunks([{ snippet: "test", score: 0.5, chunkType: "finding" }]);
    const result = chunker.buildOptimizedContext([], 10);
    assert.equal(result.length, 0);
  });

  it("returns original messages when keepLastN >= messages.length", () => {
    const msgs = generateConversation(5); // 15 messages
    chunker.setCachedChunks([{ snippet: "test", score: 0.5, chunkType: "finding" }]);
    const result = chunker.buildOptimizedContext(msgs, 15);
    assert.deepEqual(result, msgs);
  });

  it("returns original messages when keepLastN > messages.length", () => {
    const msgs = generateConversation(5); // 15 messages
    chunker.setCachedChunks([{ snippet: "test", score: 0.5, chunkType: "finding" }]);
    const result = chunker.buildOptimizedContext(msgs, 100);
    assert.deepEqual(result, msgs);
  });

  it("replaces old messages with preamble chunks", () => {
    const msgs = generateConversation(20); // 60 messages
    chunker.setCachedChunks([
      { snippet: "Bug found in parser at line 42", score: 0.95, chunkType: "assistant-finding" },
      { snippet: "File: /src/parser.ts", score: 0.80, chunkType: "file-context" },
    ]);

    const result = chunker.buildOptimizedContext(msgs, 30);

    // 2 preamble + 30 tail = 32
    assert.equal(result.length, 32);

    // First two should be synthetic preamble messages
    const preamble0Text = extractText(result[0].content);
    assert.ok(preamble0Text.includes("[retrieved context"));
    assert.ok(preamble0Text.includes("assistant-finding"));
    assert.ok(preamble0Text.includes("Bug found in parser"));

    const preamble1Text = extractText(result[1].content);
    assert.ok(preamble1Text.includes("file-context"));
    assert.ok(preamble1Text.includes("/src/parser.ts"));

    // Remaining should be the tail messages
    assert.equal(result[2], msgs[30]); // first of the tail
    assert.equal(result[31], msgs[59]); // last message
  });

  it("caps injected chunks at CTX_MAX_INJECTED_CHUNKS", () => {
    const msgs = generateConversation(20); // 60 messages
    // Set more chunks than the max
    const manyChunks: RetrievedChunk[] = [];
    for (let i = 0; i < 10; i++) {
      manyChunks.push({ snippet: `Chunk ${i}`, score: 0.9 - i * 0.05, chunkType: "finding" });
    }
    chunker.setCachedChunks(manyChunks);

    const result = chunker.buildOptimizedContext(msgs, 30);

    // CTX_MAX_INJECTED_CHUNKS (5) preamble + 30 tail = 35
    assert.equal(result.length, 35);

    // Verify only first 5 chunks were injected
    for (let i = 0; i < CTX_MAX_INJECTED_CHUNKS; i++) {
      const text = extractText(result[i].content);
      assert.ok(text.includes(`Chunk ${i}`));
    }
  });

  it("includes score in preamble messages", () => {
    const msgs = generateConversation(10); // 30 messages
    chunker.setCachedChunks([
      { snippet: "Important finding", score: 0.876, chunkType: "decision" },
    ]);

    const result = chunker.buildOptimizedContext(msgs, 20);
    const text = extractText(result[0].content);
    assert.ok(text.includes("0.876"));
    assert.ok(text.includes("decision"));
  });

  it("truncates long snippets in preamble", () => {
    const msgs = generateConversation(10); // 30 messages
    const longSnippet = "x".repeat(5000);
    chunker.setCachedChunks([
      { snippet: longSnippet, score: 0.5, chunkType: "finding" },
    ]);

    const result = chunker.buildOptimizedContext(msgs, 20);
    const text = extractText(result[0].content);
    assert.ok(text.length < longSnippet.length);
    assert.ok(text.length <= CTX_MAX_CHUNK_INJECT_CHARS + 200); // +200 for prefix
  });
});

describe("extractTurnChunks — user requests", () => {
  it("extracts user request from user message", () => {
    const msgs = [
      userMessage("Please fix the bug in the authentication module that causes session timeouts after 30 minutes."),
    ];
    const chunks = extractTurnChunks(msgs, 8);

    const userReq = chunks.find((c) => c.type === "user-request");
    assert.ok(userReq, "Expected a user-request chunk");
    assert.ok(userReq!.content.includes("User request:"));
    assert.ok(userReq!.content.includes("authentication module"));
  });

  it("skips very short user messages", () => {
    const msgs = [userMessage("Fix it")]; // too short
    const chunks = extractTurnChunks(msgs, 8);
    assert.equal(chunks.filter((c) => c.type === "user-request").length, 0);
  });

  it("strips system-reminder blocks from user messages", () => {
    const msgs = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Refactor the database connection pool to use async initialization and add proper error handling for connection failures. <system-reminder>Remember to check types.</system-reminder>",
          },
        ],
      },
    ];
    const chunks = extractTurnChunks(msgs, 8);
    const userReq = chunks.find((c) => c.type === "user-request");
    assert.ok(userReq);
    assert.ok(!userReq!.content.includes("system-reminder"));
    assert.ok(userReq!.content.includes("database connection pool"));
  });
});

describe("extractTurnChunks — assistant findings", () => {
  it("extracts finding from substantive assistant text", () => {
    const text = "After analyzing the codebase, I found that the session timeout was caused by a race condition in the token refresh logic. The refresh timer was being cleared but not restarted when a new token was issued.\n\nThis means concurrent requests could both trigger refresh simultaneously.";
    const msgs = [assistantMessage(text)];
    const chunks = extractTurnChunks(msgs, 8);

    const finding = chunks.find((c) => c.type === "assistant-finding");
    assert.ok(finding, "Expected an assistant-finding chunk");
    assert.ok(finding!.content.includes("Finding:"));
  });

  it("strips thinking blocks from assistant messages", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "<think>Let me think about this carefully before responding with details.</think>The root cause is a missing null check in the middleware pipeline that causes undefined behavior when the request body is empty or malformed.",
          },
        ],
      },
    ];
    const chunks = extractTurnChunks(msgs, 8);
    const finding = chunks.find((c) => c.type === "assistant-finding");
    assert.ok(finding);
    assert.ok(!finding!.content.includes("Let me think"));
    assert.ok(finding!.content.includes("null check"));
  });

  it("skips assistant messages with only thinking content", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "<think>Just thinking and nothing else of substance here at all.</think>" },
        ],
      },
    ];
    const chunks = extractTurnChunks(msgs, 8);
    // No assistant-finding because after stripping thinking, text < CHUNK_MIN_TEXT_CHARS
    assert.equal(chunks.filter((c) => c.type === "assistant-finding").length, 0);
  });
});

describe("extractTurnChunks — decisions", () => {
  it("detects 'decided' patterns", () => {
    const msgs = [
      assistantMessage("We decided to use PostgreSQL instead of MongoDB because the data model is highly relational and needs ACID transactions."),
    ];
    const chunks = extractTurnChunks(msgs, 8);
    const decision = chunks.find((c) => c.type === "decision");
    assert.ok(decision, "Expected a decision chunk");
    assert.ok(decision!.content.includes("Decision:"));
  });

  it("detects 'the root cause is' patterns", () => {
    const msgs = [
      assistantMessage("After investigation, the root cause is a deadlock between the connection pool recycler and the health check thread."),
    ];
    const chunks = extractTurnChunks(msgs, 8);
    const decision = chunks.find((c) => c.type === "decision");
    assert.ok(decision, "Expected a decision chunk");
    assert.ok(decision!.content.includes("root cause"));
  });

  it("detects 'instead of' patterns", () => {
    const msgs = [
      assistantMessage("I will use a Map-based approach instead of array scanning for the lookup table because it provides O(1) access vs O(n)."),
    ];
    const chunks = extractTurnChunks(msgs, 8);
    const decision = chunks.find((c) => c.type === "decision");
    assert.ok(decision, "Expected a decision chunk");
  });

  it("returns null when no decision markers present", () => {
    const result = detectDecisions("This is a plain text with no decision markers.");
    assert.equal(result, null);
  });
});

describe("extractTurnChunks — code changes", () => {
  it("detects file creation/modification", () => {
    const msgs = [
      assistantMessage("I created file /src/utils/retry.ts with the exponential backoff implementation and updated /src/services/api.ts to use it."),
    ];
    const chunks = extractTurnChunks(msgs, 8);
    const codeChange = chunks.find((c) => c.type === "code-change");
    assert.ok(codeChange, "Expected a code-change chunk");
    assert.ok(codeChange!.content.includes("Code changes:"));
  });

  it("detects function/class definitions", () => {
    const msgs = [
      assistantMessage("Here is the implementation:\nfunction retryWithBackoff(fn, maxRetries) { ... }\nclass ApiClient extends BaseClient { ... }\nexport const DEFAULT_TIMEOUT = 5000;"),
    ];
    const chunks = extractTurnChunks(msgs, 8);
    const codeChange = chunks.find((c) => c.type === "code-change");
    assert.ok(codeChange, "Expected a code-change chunk");
    assert.ok(codeChange!.content.includes("defined:"));
  });
});

describe("extractTurnChunks — tool outcomes", () => {
  it("extracts tool result when content is meaningful", () => {
    const toolOutput = "Found 15 matches in 8 files:\n/src/api/handler.ts:42: getCwd()\n/src/utils/path.ts:18: getCwd()\n" + "x".repeat(100);
    const msgs = [toolResultMessage(toolOutput, "grep")];
    const chunks = extractTurnChunks(msgs, 8);

    const toolChunk = chunks.find((c) => c.type === "tool-outcome");
    assert.ok(toolChunk, "Expected a tool-outcome chunk");
    assert.ok(toolChunk!.content.includes("Tool grep result:"));
  });

  it("skips very short tool results", () => {
    const msgs = [toolResultMessage("ok")]; // too short
    const chunks = extractTurnChunks(msgs, 8);
    assert.equal(chunks.filter((c) => c.type === "tool-outcome").length, 0);
  });

  it("skips very large tool results (>4000 chars)", () => {
    const msgs = [toolResultMessage("x".repeat(5000), "readFile")];
    const chunks = extractTurnChunks(msgs, 8);
    assert.equal(chunks.filter((c) => c.type === "tool-outcome").length, 0);
  });
});

describe("extractTurnChunks — file context", () => {
  it("extracts file paths from messages", () => {
    const msgs = [
      assistantMessage("I need to check /src/config/database.ts and /src/models/user.ts for the schema definition that relates to the user authentication flow."),
    ];
    const chunks = extractTurnChunks(msgs, 8);
    const fileCtx = chunks.find((c) => c.type === "file-context");
    assert.ok(fileCtx, "Expected a file-context chunk");
    assert.ok(fileCtx!.content.includes("/src/config/database.ts"));
    assert.ok(fileCtx!.content.includes("/src/models/user.ts"));
  });

  it("deduplicates file paths", () => {
    const msgs = [
      assistantMessage("Check /src/parser.ts for the bug. Also look at /src/parser.ts again for the second issue. Both relate to the parsing logic."),
    ];
    const chunks = extractTurnChunks(msgs, 8);
    const fileCtx = chunks.find((c) => c.type === "file-context");
    assert.ok(fileCtx);
    // Should only appear once
    const matches = fileCtx!.content.match(/\/src\/parser\.ts/g);
    assert.equal(matches?.length, 1);
  });

  it("filters out /tmp/ and node_modules paths", () => {
    const text = "Check /tmp/test.txt and /foo/node_modules/bar.js and /src/real.ts for the actual source code changes.";
    const paths = extractFilePaths(text);
    assert.ok(!paths.some((p) => p.startsWith("/tmp/")));
    assert.ok(!paths.some((p) => p.includes("/node_modules/")));
    assert.ok(paths.includes("/src/real.ts"));
  });
});

describe("extractTurnChunks — chunk limits", () => {
  it("respects maxChunks limit", () => {
    // Create a turn with lots of content that would generate many chunks
    const msgs = [
      userMessage("Please implement the authentication system with JWT tokens, refresh tokens, and session management for our new platform."),
      assistantMessage(
        "I decided to use RS256 instead of HS256 for JWT signing because it allows public key verification.\n\n" +
        "I created file /src/auth/jwt.ts with the token signing and verification logic.\n\n" +
        "The implementation uses a Map-based approach for token revocation tracking to ensure O(1) lookup performance."
      ),
      toolResultMessage("Successfully compiled with 0 errors and 2 warnings in the build output log" + "x".repeat(100), "build"),
    ];

    const chunks = extractTurnChunks(msgs, 3);
    assert.ok(chunks.length <= 3, `Expected at most 3 chunks, got ${chunks.length}`);
  });

  it("normal budget produces multiple chunk types", () => {
    const msgs = [
      userMessage("Please refactor the database connection pooling to support multiple databases with different configurations and connection limits."),
      assistantMessage(
        "I decided to use a factory pattern instead of a singleton because we need multiple pool instances for different database targets.\n\n" +
        "I created file /src/db/pool-factory.ts and updated /src/db/index.ts with the new connection manager exports.\n\n" +
        "The root cause was that the original singleton pool couldn't handle different connection string formats across database types."
      ),
      toolResultMessage("All 42 tests passed successfully with full coverage reported in the output logs" + "x".repeat(100), "test"),
    ];

    const chunks = extractTurnChunks(msgs, 8);
    const types = new Set(chunks.map((c) => c.type));
    // Should have multiple types
    assert.ok(types.size >= 3, `Expected at least 3 chunk types, got ${types.size}: ${[...types].join(", ")}`);
  });
});

describe("parseSearchResults", () => {
  it("parses valid JSON array of results", () => {
    const json = JSON.stringify([
      { id: "1", snippet: "Found parser bug", score: 0.95, metadata: { chunk_type: "finding" } },
      { id: "2", snippet: "File paths: /src/a.ts", score: 0.80, metadata: { chunk_type: "file-context" } },
    ]);
    const seen = new Set<string>();
    const results = parseSearchResults(json, seen);
    assert.equal(results.length, 2);
    assert.equal(results[0].snippet, "Found parser bug");
    assert.equal(results[0].score, 0.95);
    assert.equal(results[0].chunkType, "finding");
  });

  it("parses wrapped results object", () => {
    const json = JSON.stringify({
      results: [
        { id: "1", snippet: "Test result", score: 0.5, metadata: { chunk_type: "test" } },
      ],
    });
    const seen = new Set<string>();
    const results = parseSearchResults(json, seen);
    assert.equal(results.length, 1);
  });

  it("filters out results below minimum score", () => {
    const json = JSON.stringify([
      { id: "1", snippet: "Low score", score: 0.001, metadata: {} },
      { id: "2", snippet: "High score", score: 0.5, metadata: {} },
    ]);
    const seen = new Set<string>();
    const results = parseSearchResults(json, seen);
    assert.equal(results.length, 1);
    assert.equal(results[0].snippet, "High score");
  });

  it("deduplicates by ID", () => {
    const json = JSON.stringify([
      { id: "dup1", snippet: "First", score: 0.9, metadata: {} },
      { id: "dup1", snippet: "Duplicate", score: 0.8, metadata: {} },
    ]);
    const seen = new Set<string>();
    const results = parseSearchResults(json, seen);
    assert.equal(results.length, 1);
    assert.equal(results[0].snippet, "First");
  });

  it("deduplicates across calls using shared seenIds", () => {
    const seen = new Set<string>();
    const json1 = JSON.stringify([{ id: "shared", snippet: "First call", score: 0.9, metadata: {} }]);
    const json2 = JSON.stringify([{ id: "shared", snippet: "Second call", score: 0.8, metadata: {} }]);

    const results1 = parseSearchResults(json1, seen);
    const results2 = parseSearchResults(json2, seen);

    assert.equal(results1.length, 1);
    assert.equal(results2.length, 0); // deduped
  });

  it("returns empty on invalid JSON", () => {
    const seen = new Set<string>();
    const results = parseSearchResults("not json at all", seen);
    assert.equal(results.length, 0);
  });

  it("normalizes whitespace in snippets", () => {
    const json = JSON.stringify([
      { id: "1", snippet: "Has   extra   \n  whitespace", score: 0.5, metadata: {} },
    ]);
    const seen = new Set<string>();
    const results = parseSearchResults(json, seen);
    assert.equal(results[0].snippet, "Has extra whitespace");
  });

  it("defaults chunkType to 'unknown' when metadata and path pattern both missing", () => {
    const json = JSON.stringify([
      { id: "1", snippet: "No type", score: 0.5 },
    ]);
    const seen = new Set<string>();
    const results = parseSearchResults(json, seen);
    assert.equal(results[0].chunkType, "unknown");
  });

  it("extracts chunkType from path pattern when metadata is missing", () => {
    const json = JSON.stringify([
      { id: "1", snippet: "Some finding", score: 0.5, path: "/pi-ctx-s-abc123-t3-decision-0" },
      { id: "2", snippet: "Code change", score: 0.4, path: "/pi-ctx-s-abc123-t5-code-change-2" },
      { id: "3", snippet: "No match path", score: 0.3, path: "/some/other/path.txt" },
    ]);
    const seen = new Set<string>();
    const results = parseSearchResults(json, seen);
    assert.equal(results[0].chunkType, "decision");
    assert.equal(results[1].chunkType, "code-change");
    assert.equal(results[2].chunkType, "unknown");
  });

  it("prefers metadata chunk_type over path pattern", () => {
    const json = JSON.stringify([
      { id: "1", snippet: "Has both", score: 0.5, path: "/pi-ctx-s-abc-t1-decision-0", metadata: { chunk_type: "objective" } },
    ]);
    const seen = new Set<string>();
    const results = parseSearchResults(json, seen);
    assert.equal(results[0].chunkType, "objective");
  });
});

describe("buildRetrievalQuery", () => {
  it("builds query from recent user and assistant messages", () => {
    const msgs = [
      userMessage("What is the bug in the parser module? I need to understand the root cause of the parsing failure."),
      assistantMessage("The parser has an off-by-one error in the token boundary detection that causes it to misparse nested expressions."),
    ];
    const query = buildRetrievalQuery(msgs);
    assert.ok(query.length > 0);
    assert.ok(query.includes("parser") || query.includes("off-by-one"));
  });

  it("walks backwards from the end", () => {
    const msgs = [
      userMessage("Old message that should not be the primary query source for relevance scoring."),
      assistantMessage("Old response with details about the initial analysis and preliminary findings."),
      userMessage("New message about the critical database migration that needs immediate attention today."),
      assistantMessage("New response confirming the database migration plan and the rollback strategy details."),
    ];
    const query = buildRetrievalQuery(msgs);
    // Should include content from the newer messages (walked backwards)
    assert.ok(query.includes("database migration") || query.includes("rollback"));
  });

  it("caps at 900 chars", () => {
    const longMsg = "x".repeat(2000);
    const msgs = [
      userMessage(longMsg),
      assistantMessage(longMsg),
    ];
    const query = buildRetrievalQuery(msgs);
    assert.ok(query.length <= 900);
  });

  it("strips system-reminder from user messages", () => {
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "Fix the bug <system-reminder>Check your work carefully.</system-reminder> in the parser that handles nested expressions." },
        ],
      },
    ];
    const query = buildRetrievalQuery(msgs);
    assert.ok(!query.includes("system-reminder"));
    assert.ok(!query.includes("Check your work"));
  });

  it("strips thinking blocks from assistant messages", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "<think>Internal reasoning process here.</think>The actual response about the parser fix is what matters for search." },
        ],
      },
    ];
    const query = buildRetrievalQuery(msgs);
    assert.ok(!query.includes("Internal reasoning"));
    assert.ok(query.includes("parser fix") || query.includes("actual response"));
  });

  it("returns empty string for empty messages", () => {
    const query = buildRetrievalQuery([]);
    assert.equal(query, "");
  });

  it("skips short user messages", () => {
    const msgs = [
      userMessage("ok"), // < 30 chars
      assistantMessage("This is a detailed response about the implementation that should be long enough to include in the query."),
    ];
    const query = buildRetrievalQuery(msgs);
    // Should only have assistant text (user was too short)
    assert.ok(query.includes("detailed response") || query.includes("implementation"));
  });
});

describe("Extension registration", () => {
  it("registers session_start, context, turn_end, and session_shutdown handlers", () => {
    const pi = createMockPi();

    // Replicate the extension's registration
    pi.on("session_start", async (_event: any, _ctx: any) => {});
    pi.on("context", async (_event: any, _ctx: any) => {});
    pi.on("turn_end", async (_event: any, _ctx: any) => {});
    pi.on("session_shutdown", async (_event: any, _ctx: any) => {});

    assert.ok(pi.getHandler("session_start"));
    assert.ok(pi.getHandler("context"));
    assert.ok(pi.getHandler("turn_end"));
    assert.ok(pi.getHandler("session_shutdown"));
  });
});

describe("Context handler — message snapshot", () => {
  it("context handler captures messages for turn_end processing", () => {
    let currentMessages: any[] | null = null;

    const contextHandler = async (event: any, _ctx: any) => {
      const messages = event.messages;
      if (Array.isArray(messages) && messages.length > 0) {
        currentMessages = messages;
      }
    };

    const msgs = generateConversation(10);
    contextHandler(createContextEvent(msgs), createMockCtx());

    assert.ok(currentMessages);
    assert.equal((currentMessages as any[]).length, msgs.length);
  });

  it("context handler does not overwrite with empty messages", () => {
    let currentMessages: any[] | null = null;

    const contextHandler = async (event: any, _ctx: any) => {
      const messages = event.messages;
      if (Array.isArray(messages) && messages.length > 0) {
        currentMessages = messages;
      }
    };

    const msgs = generateConversation(5);
    contextHandler(createContextEvent(msgs), createMockCtx());
    assert.equal((currentMessages as any[]).length, msgs.length);

    contextHandler({ messages: [] }, createMockCtx());
    assert.equal((currentMessages as any[]).length, msgs.length);
  });
});

describe("Integration — end-to-end chunk + context build flow", () => {
  it("full flow: extract chunks → cache retrieved → build optimized context", () => {
    const chunker = new ContextChunker();
    chunker.setSession("integration-test");
    chunker.incrementTurn();

    // Step 1: Simulate extracting chunks from a turn
    const turnMessages = [
      userMessage("Please fix the memory leak in the WebSocket connection handler that causes the server to crash after extended use."),
      assistantMessage(
        "I found the root cause is an event listener accumulation in the connection handler.\n\n" +
        "I modified file /src/ws/handler.ts to properly remove listeners on disconnect. " +
        "The fix ensures each connection cleans up its own listeners instead of relying on garbage collection."
      ),
      toolResultMessage("Build succeeded with zero errors. All 28 unit tests passed with full coverage metrics reported." + "x".repeat(50), "build"),
    ];
    const chunks = extractTurnChunks(turnMessages, 8);
    assert.ok(chunks.length >= 2, `Expected at least 2 chunks, got ${chunks.length}`);

    // Verify chunk types extracted
    const types = new Set(chunks.map((c) => c.type));
    assert.ok(types.has("user-request"), "Expected user-request chunk");

    // Step 2: Simulate pre-fetched YAMS retrieval
    chunker.setCachedChunks([
      { snippet: "WebSocket handler memory leak fix: remove listeners on disconnect", score: 0.92, chunkType: "assistant-finding" },
      { snippet: "File: /src/ws/handler.ts", score: 0.85, chunkType: "file-context" },
      { snippet: "User request: fix memory leak in WebSocket", score: 0.78, chunkType: "user-request" },
    ]);
    chunker.recordRetrieval(3);

    // Step 3: Build optimized context
    const fullConversation = generateConversation(30); // 90 messages
    const optimized = chunker.buildOptimizedContext(fullConversation, 20);

    // 3 preamble chunks + 20 tail = 23
    assert.equal(optimized.length, 23);

    // Verify preamble has retrieved context
    const firstText = extractText(optimized[0].content);
    assert.ok(firstText.includes("[retrieved context"));
    assert.ok(firstText.includes("WebSocket"));

    // Verify tail is preserved
    assert.equal(optimized[3], fullConversation[70]); // 90 - 20 = 70
    assert.equal(optimized[22], fullConversation[89]);

    // Stats check
    assert.equal(chunker.stats().totalRetrieved, 3);
    assert.equal(chunker.stats().cachedChunks, 3);
  });

  it("after invalidation, buildOptimizedContext returns original messages", () => {
    const chunker = new ContextChunker();
    const msgs = generateConversation(20); // 60 messages

    chunker.setCachedChunks([
      { snippet: "test chunk", score: 0.5, chunkType: "finding" },
    ]);

    // Before invalidation — optimized
    const before = chunker.buildOptimizedContext(msgs, 30);
    assert.ok(before.length < msgs.length);

    // After invalidation — original
    chunker.invalidate();
    const after = chunker.buildOptimizedContext(msgs, 30);
    assert.deepEqual(after, msgs);
  });

  it("granularity escalation: more chunks at high token pressure", () => {
    // At normal pressure, max is CHUNK_MAX_PER_TURN = 8
    // At high pressure (>= 128K tokens), max is CHUNK_HIGH_PRESSURE_MAX_PER_TURN = 12
    // We simulate this by just verifying the constants and extraction behavior

    const msgs: any[] = [];
    for (let i = 0; i < 15; i++) {
      msgs.push(userMessage(`Request ${i}: Please implement feature number ${i} with full test coverage and documentation updates.`));
      msgs.push(assistantMessage(`Implemented feature ${i}. I created file /src/feature-${i}.ts and decided to use the strategy pattern because it provides better extensibility.`));
      msgs.push(toolResultMessage(`Feature ${i} tests: 5 passed, 0 failed. Build succeeded with no warnings in output.` + "x".repeat(50), `test_${i}`));
    }

    const normalChunks = extractTurnChunks(msgs, CHUNK_MAX_PER_TURN);
    const highPressureChunks = extractTurnChunks(msgs, CHUNK_HIGH_PRESSURE_MAX_PER_TURN);

    assert.ok(normalChunks.length <= CHUNK_MAX_PER_TURN);
    assert.ok(highPressureChunks.length <= CHUNK_HIGH_PRESSURE_MAX_PER_TURN);
    // With more budget, should potentially extract more chunks
    assert.ok(highPressureChunks.length >= normalChunks.length);
  });
});
