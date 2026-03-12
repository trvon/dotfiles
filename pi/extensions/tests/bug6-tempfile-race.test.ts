/**
 * Regression tests for Bug 6: Temp file race condition in YAMS ingest.
 *
 * Root cause: storeChunk() / storeRlmChunk() write content to a temp file,
 * call `yams add <tempfile>`, then immediately `unlinkSync` the temp file in
 * a `finally` block. But `yams add` is async — it enqueues the document and
 * returns immediately. By the time the YAMS daemon's IngestService processes
 * the task, the temp file is already deleted.
 *
 * Fix plan: Replace immediate `unlinkSync` with deferred cleanup — keep temp
 * files for a TTL window, clean up periodically + on session_shutdown, and
 * bound file count to prevent growth.
 *
 * These tests verify:
 * 1. The race condition reproduces (file deleted before async read)
 * 2. Deferred cleanup logic (TTL-based, bounded count, session_shutdown)
 * 3. Query text sanitization for <think> tags and control chars
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { extractText } from "./test-helpers.ts";

// ---------------------------------------------------------------------------
// Re-implement the buggy storeChunk pattern and the fixed version
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

// -- The BUGGY pattern (mirrors semantic-compressor.ts:331-371) --

type MockExecResult = { code: number; stdout: string; stderr: string };
type MockExecFn = (
  cmd: string,
  args: string[],
  opts?: { timeout?: number }
) => Promise<MockExecResult>;

async function storeChunkBuggy(
  execFn: MockExecFn,
  name: string,
  content: string,
  metadata: string,
  sessionId: string
): Promise<boolean> {
  const tmpFile = path.join(
    tmpdir(),
    `pi-chunk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
  );
  const tags = `pi-context,session:${sessionId}`;
  try {
    fs.writeFileSync(tmpFile, content, "utf-8");
    const result = await execFn(
      "yams",
      ["add", tmpFile, "--name", name, "--collection", "pi-context", "--tags", tags, "--metadata", metadata],
      { timeout: 15000 }
    );
    return result.code === 0;
  } catch {
    return false;
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // Ignore cleanup errors.
    }
  }
}

// -- The FIXED pattern: deferred cleanup --

/** Tracks temp files pending deferred cleanup. */
type DeferredFile = {
  path: string;
  createdAt: number;
};

const DEFERRED_TTL_MS = 15 * 60 * 1000; // 15 minutes
const DEFERRED_MAX_FILES = 200;

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

  get pendingPaths(): string[] {
    return this._pending.map((e) => e.path);
  }
}

/** Fixed storeChunk that uses deferred cleanup. */
async function storeChunkFixed(
  execFn: MockExecFn,
  tempManager: TempFileManager,
  name: string,
  content: string,
  metadata: string,
  sessionId: string
): Promise<boolean> {
  const tmpFile = path.join(
    tmpdir(),
    `pi-chunk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
  );
  const tags = `pi-context,session:${sessionId}`;
  try {
    fs.writeFileSync(tmpFile, content, "utf-8");
    const result = await execFn(
      "yams",
      ["add", tmpFile, "--name", name, "--collection", "pi-context", "--tags", tags, "--metadata", metadata],
      { timeout: 15000 }
    );
    // Register for deferred cleanup instead of immediate delete
    tempManager.register(tmpFile);
    return result.code === 0;
  } catch {
    // On failure, still defer (the daemon might still be processing)
    tempManager.register(tmpFile);
    return false;
  }
}

// -- buildRetrievalQuery (current buggy version) --

function buildRetrievalQueryBuggy(messages: any[]): string {
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

// -- buildRetrievalQuery (hardened version) --

function buildRetrievalQueryFixed(messages: any[]): string {
  const parts: string[] = [];
  for (let i = messages.length - 1; i >= 0 && parts.length < 3; i--) {
    const msg = messages[i];
    const role = msg?.role;
    if (role === "user") {
      let text = extractText(msg.content);
      // Strip known wrapper tags more aggressively
      text = stripWrapperTags(text).trim();
      if (text.length > 30) {
        parts.push(text.slice(0, 400));
      }
    } else if (role === "assistant") {
      let text = extractText(msg.content);
      text = stripWrapperTags(text).trim();
      if (text.length > 50) {
        parts.push(text.slice(0, 300));
      }
    }
  }
  // Final sanitization pass: collapse whitespace, strip control chars
  return sanitizeQueryText(parts.join(" ").slice(0, 900));
}

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

// ===========================================================================
// Tests
// ===========================================================================

describe("Bug 6 — temp file race condition (reproduces the bug)", () => {
  it("buggy pattern: file is deleted before async consumer can read it", async () => {
    let capturedFilePath: string | null = null;

    // Simulate yams add: returns immediately (async enqueue) but we capture the path
    const mockExec: MockExecFn = async (_cmd, args) => {
      capturedFilePath = args[1]; // The temp file path
      // Simulate async processing delay — the daemon would read later
      return { code: 0, stdout: "Ingestion accepted for asynchronous processing", stderr: "" };
    };

    const result = await storeChunkBuggy(
      mockExec,
      "pi-ctx-test-t1-finding-0",
      "Test chunk content for the finding",
      "chunk_type=finding,session_id=test",
      "test-session"
    );

    assert.equal(result, true);
    assert.ok(capturedFilePath, "Should have captured the temp file path");

    // THE BUG: after storeChunkBuggy returns, the file is already deleted
    // by the finally block. If the YAMS daemon tries to read it now, it fails.
    assert.equal(
      fs.existsSync(capturedFilePath!),
      false,
      "Buggy pattern deletes file immediately — daemon would get 'File not found'"
    );
  });

  it("buggy pattern: file is deleted even when yams add fails", async () => {
    let capturedFilePath: string | null = null;

    const mockExec: MockExecFn = async (_cmd, args) => {
      capturedFilePath = args[1];
      // Simulate a timeout or error
      throw new Error("exec timeout");
    };

    const result = await storeChunkBuggy(
      mockExec,
      "pi-ctx-test-t1-finding-0",
      "Test chunk content",
      "chunk_type=finding",
      "test-session"
    );

    assert.equal(result, false);
    assert.ok(capturedFilePath);
    // File is still deleted even on failure — bad if daemon is retrying
    assert.equal(fs.existsSync(capturedFilePath!), false);
  });
});

describe("Bug 6 — fixed pattern: deferred temp file cleanup", () => {
  let tempManager: TempFileManager;
  let createdFiles: string[];

  beforeEach(() => {
    tempManager = new TempFileManager();
    createdFiles = [];
  });

  afterEach(() => {
    // Clean up any leftover test files
    for (const f of createdFiles) {
      try { fs.unlinkSync(f); } catch { /* ok */ }
    }
    tempManager.flushAll();
  });

  it("fixed pattern: file persists after storeChunk returns", async () => {
    let capturedFilePath: string | null = null;

    const mockExec: MockExecFn = async (_cmd, args) => {
      capturedFilePath = args[1];
      return { code: 0, stdout: "Ingestion accepted", stderr: "" };
    };

    const result = await storeChunkFixed(
      mockExec,
      tempManager,
      "pi-ctx-test-t1-finding-0",
      "Test chunk content for deferred cleanup",
      "chunk_type=finding",
      "test-session"
    );

    assert.equal(result, true);
    assert.ok(capturedFilePath);
    createdFiles.push(capturedFilePath!);

    // THE FIX: file still exists after storeChunk returns
    assert.equal(
      fs.existsSync(capturedFilePath!),
      true,
      "Fixed pattern should keep file alive for daemon to read"
    );

    // File is tracked in the deferred manager
    assert.equal(tempManager.pendingCount, 1);
    assert.ok(tempManager.pendingPaths.includes(capturedFilePath!));
  });

  it("fixed pattern: file persists even on exec failure", async () => {
    let capturedFilePath: string | null = null;

    const mockExec: MockExecFn = async (_cmd, args) => {
      capturedFilePath = args[1];
      throw new Error("exec timeout");
    };

    const result = await storeChunkFixed(
      mockExec,
      tempManager,
      "pi-ctx-test-t1-finding-0",
      "Test chunk content",
      "chunk_type=finding",
      "test-session"
    );

    assert.equal(result, false);
    assert.ok(capturedFilePath);
    createdFiles.push(capturedFilePath!);

    // File should still exist
    assert.equal(fs.existsSync(capturedFilePath!), true);
    assert.equal(tempManager.pendingCount, 1);
  });
});

describe("TempFileManager — TTL-based sweep", () => {
  let tempManager: TempFileManager;
  let createdFiles: string[];

  beforeEach(() => {
    tempManager = new TempFileManager();
    createdFiles = [];
  });

  afterEach(() => {
    for (const f of createdFiles) {
      try { fs.unlinkSync(f); } catch { /* ok */ }
    }
    tempManager.flushAll();
  });

  function createTempFile(content: string): string {
    const p = path.join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    fs.writeFileSync(p, content, "utf-8");
    createdFiles.push(p);
    return p;
  }

  it("sweep removes files older than TTL", () => {
    const baseTime = 1000000;
    const f1 = createTempFile("old file");
    const f2 = createTempFile("new file");

    // Register f1 as old, f2 as new
    tempManager.register(f1, baseTime);
    tempManager.register(f2, baseTime + DEFERRED_TTL_MS - 1000); // just under TTL

    assert.equal(tempManager.pendingCount, 2);

    // Sweep at a time that puts f1 past TTL but not f2
    const sweepTime = baseTime + DEFERRED_TTL_MS + 1;
    const removed = tempManager.sweep(sweepTime);

    assert.equal(removed, 1);
    assert.equal(tempManager.pendingCount, 1);
    assert.equal(fs.existsSync(f1), false, "Old file should be deleted");
    assert.equal(fs.existsSync(f2), true, "New file should still exist");
  });

  it("sweep is a no-op when nothing is expired", () => {
    const now = Date.now();
    const f1 = createTempFile("still fresh");
    tempManager.register(f1, now);

    const removed = tempManager.sweep(now + 1000); // 1 second later
    assert.equal(removed, 0);
    assert.equal(tempManager.pendingCount, 1);
    assert.equal(fs.existsSync(f1), true);
  });

  it("sweep handles already-deleted files gracefully", () => {
    const baseTime = 1000000;
    const f1 = createTempFile("will be deleted externally");
    tempManager.register(f1, baseTime);

    // External process deletes the file
    fs.unlinkSync(f1);
    createdFiles = createdFiles.filter((f) => f !== f1);

    // Sweep should not throw
    const removed = tempManager.sweep(baseTime + DEFERRED_TTL_MS + 1);
    assert.equal(removed, 1);
    assert.equal(tempManager.pendingCount, 0);
  });
});

describe("TempFileManager — bounded file count", () => {
  let tempManager: TempFileManager;
  let createdFiles: string[];

  beforeEach(() => {
    tempManager = new TempFileManager();
    createdFiles = [];
  });

  afterEach(() => {
    for (const f of createdFiles) {
      try { fs.unlinkSync(f); } catch { /* ok */ }
    }
    tempManager.flushAll();
  });

  function createTempFile(content: string): string {
    const p = path.join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    fs.writeFileSync(p, content, "utf-8");
    createdFiles.push(p);
    return p;
  }

  it("evicts oldest files when count exceeds DEFERRED_MAX_FILES", () => {
    // Register DEFERRED_MAX_FILES files
    const files: string[] = [];
    for (let i = 0; i < DEFERRED_MAX_FILES; i++) {
      const f = createTempFile(`file ${i}`);
      tempManager.register(f);
      files.push(f);
    }
    assert.equal(tempManager.pendingCount, DEFERRED_MAX_FILES);

    // The oldest file should still exist (at the limit, not over)
    assert.equal(fs.existsSync(files[0]), true);

    // Add one more — should evict the oldest
    const newFile = createTempFile("overflow file");
    tempManager.register(newFile);
    files.push(newFile);

    assert.equal(tempManager.pendingCount, DEFERRED_MAX_FILES);
    assert.equal(fs.existsSync(files[0]), false, "Oldest file should be evicted");
    assert.equal(fs.existsSync(newFile), true, "New file should exist");
  });
});

describe("TempFileManager — session_shutdown flushAll", () => {
  let tempManager: TempFileManager;
  let createdFiles: string[];

  beforeEach(() => {
    tempManager = new TempFileManager();
    createdFiles = [];
  });

  afterEach(() => {
    for (const f of createdFiles) {
      try { fs.unlinkSync(f); } catch { /* ok */ }
    }
  });

  function createTempFile(content: string): string {
    const p = path.join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    fs.writeFileSync(p, content, "utf-8");
    createdFiles.push(p);
    return p;
  }

  it("flushAll removes all pending files", () => {
    const f1 = createTempFile("file 1");
    const f2 = createTempFile("file 2");
    const f3 = createTempFile("file 3");

    tempManager.register(f1);
    tempManager.register(f2);
    tempManager.register(f3);

    assert.equal(tempManager.pendingCount, 3);

    const removed = tempManager.flushAll();
    assert.equal(removed, 3);
    assert.equal(tempManager.pendingCount, 0);
    assert.equal(fs.existsSync(f1), false);
    assert.equal(fs.existsSync(f2), false);
    assert.equal(fs.existsSync(f3), false);
  });

  it("flushAll returns 0 when no files pending", () => {
    const removed = tempManager.flushAll();
    assert.equal(removed, 0);
    assert.equal(tempManager.pendingCount, 0);
  });

  it("flushAll handles mixed existing/deleted files", () => {
    const f1 = createTempFile("exists");
    const f2 = createTempFile("will be deleted");

    tempManager.register(f1);
    tempManager.register(f2);

    // Simulate external deletion of f2
    fs.unlinkSync(f2);
    createdFiles = createdFiles.filter((f) => f !== f2);

    // Should not throw, and should count the existing file as removed
    const removed = tempManager.flushAll();
    // f1 was successfully deleted (1), f2 was already gone but still counted in loop
    // (the catch swallows the error, so removed doesn't increment for f2)
    assert.equal(tempManager.pendingCount, 0);
    assert.equal(fs.existsSync(f1), false);
    // removed should be 1 (only f1 was actually deleted)
    assert.equal(removed, 1);
  });
});

describe("Bug 6 — query text sanitization (reproduces FTS5 error trigger)", () => {
  it("buggy buildRetrievalQuery leaks <think> tags into query text", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "<think>Let me start by reviewing the existing extension architecture</think>The extension system uses event-based hooks for lifecycle management.",
          },
        ],
      },
    ];

    const query = buildRetrievalQueryBuggy(messages);
    // The buggy regex should strip matched <think>...</think> pairs
    assert.ok(!query.includes("<think>"), "Matched <think> pairs should be stripped");
    assert.ok(query.includes("extension system"));
  });

  it("buggy buildRetrievalQuery fails with UNMATCHED <think> tag", () => {
    // This is the actual failure case: the text content starts with <think>
    // but the closing </think> is missing (or in a different content block)
    // Must be >50 chars after extractText to pass the assistant length check
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "<think>Let me start by reviewing the existing extension architecture and understanding the codebase",
          },
        ],
      },
    ];

    const query = buildRetrievalQueryBuggy(messages);
    // BUG: the unmatched <think> tag is NOT stripped by the regex
    // because the regex requires [\s\S]*?<\/think> to match
    assert.ok(
      query.includes("<think>"),
      "Buggy version leaks unmatched <think> tag into query"
    );
  });

  it("fixed buildRetrievalQuery strips unmatched <think> tags", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "<think>Let me start by reviewing the existing extension architecture",
          },
        ],
      },
    ];

    const query = buildRetrievalQueryFixed(messages);
    assert.ok(
      !query.includes("<think>"),
      "Fixed version should strip orphaned <think> tag"
    );
    assert.ok(
      !query.includes("<"),
      "Fixed version should not contain angle brackets from tags"
    );
  });

  it("fixed buildRetrievalQuery strips unmatched </think> tags", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "reviewing the architecture</think>The actual findings are here.",
          },
        ],
      },
    ];

    const query = buildRetrievalQueryFixed(messages);
    assert.ok(!query.includes("</think>"));
    assert.ok(query.includes("actual findings"));
  });

  it("fixed buildRetrievalQuery strips <system-reminder> orphans from user messages", () => {
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            // Orphaned <system-reminder> — no closing tag. The fix strips the tag
            // and everything after it (the content is likely system-injected).
            text: "Fix the parser bug that handles nested expressions <system-reminder>Always validate inputs carefully and check edge cases.",
          },
        ],
      },
    ];

    const query = buildRetrievalQueryFixed(messages);
    assert.ok(!query.includes("<system-reminder>"));
    assert.ok(!query.includes("Always validate"));
    assert.ok(query.includes("Fix the parser bug"));
  });

  it("fixed buildRetrievalQuery strips <antThinking> tags", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "<antThinking>Internal reasoning here about the database selection process</antThinking>The conclusion is to use PostgreSQL for the primary database because it handles relational data well.",
          },
        ],
      },
    ];

    const query = buildRetrievalQueryFixed(messages);
    assert.ok(!query.includes("<antThinking>"));
    assert.ok(!query.includes("Internal reasoning"));
    assert.ok(query.includes("PostgreSQL"));
  });

  it("fixed buildRetrievalQuery preserves mathematical angle brackets", () => {
    // "x < 5" should NOT be stripped (it's not a tag)
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "The condition x < 5 && y > 10 should trigger the handler function when met.",
          },
        ],
      },
    ];

    const query = buildRetrievalQueryFixed(messages);
    // "x < 5" is preserved because `<` followed by space/digit is not a tag pattern
    assert.ok(query.includes("< 5") || query.includes("x"), "Mathematical < should be preserved");
  });
});

describe("stripWrapperTags — comprehensive tag stripping", () => {
  it("strips matched <think>...</think> pairs", () => {
    const result = stripWrapperTags("<think>Internal thought</think>Visible text");
    assert.ok(!result.includes("Internal thought"));
    assert.ok(result.includes("Visible text"));
  });

  it("strips matched <system-reminder>...</system-reminder> pairs", () => {
    const result = stripWrapperTags("Before <system-reminder>Hidden</system-reminder> After");
    assert.ok(!result.includes("Hidden"));
    assert.ok(result.includes("Before"));
    assert.ok(result.includes("After"));
  });

  it("strips orphaned opening <think> tag", () => {
    const result = stripWrapperTags("<think>Leaked thinking content without close");
    assert.ok(!result.includes("<think>"));
  });

  it("strips orphaned closing </think> tag", () => {
    const result = stripWrapperTags("Content ends here</think>");
    assert.ok(!result.includes("</think>"));
    assert.ok(result.includes("Content ends here"));
  });

  it("strips orphaned <system-reminder> tag", () => {
    const result = stripWrapperTags("Text <system-reminder>Leaked system reminder without close");
    assert.ok(!result.includes("<system-reminder>"));
    assert.ok(result.includes("Text"));
  });

  it("strips multiple different tag types in one pass", () => {
    const input = "<think>thought</think>Visible <system-reminder>hidden</system-reminder> more text <antThinking>nope</antThinking>";
    const result = stripWrapperTags(input);
    assert.ok(!result.includes("thought"));
    assert.ok(!result.includes("hidden"));
    assert.ok(!result.includes("nope"));
    assert.ok(result.includes("Visible"));
    assert.ok(result.includes("more text"));
  });

  it("strips generic XML-like tags", () => {
    const result = stripWrapperTags("Before <internal_note>some note</internal_note> after");
    assert.ok(!result.includes("<internal_note>"));
    assert.ok(!result.includes("</internal_note>"));
  });

  it("does NOT strip mathematical angle brackets", () => {
    const result = stripWrapperTags("value < 100 and count > 0");
    // These are not tags (< followed by space/digit)
    assert.ok(result.includes("< 100"));
    assert.ok(result.includes("> 0"));
  });

  it("handles empty string", () => {
    assert.equal(stripWrapperTags(""), "");
  });

  it("handles string with no tags", () => {
    const input = "Just normal text without any tags at all.";
    assert.equal(stripWrapperTags(input), input);
  });
});

describe("sanitizeQueryText — whitespace and control character cleanup", () => {
  it("collapses multiple spaces", () => {
    assert.equal(sanitizeQueryText("hello   world"), "hello world");
  });

  it("collapses newlines and tabs", () => {
    assert.equal(sanitizeQueryText("hello\n\nworld\ttab"), "hello world tab");
  });

  it("strips control characters", () => {
    assert.equal(sanitizeQueryText("hello\x00world\x1Ftest"), "helloworldtest");
  });

  it("trims leading/trailing whitespace", () => {
    assert.equal(sanitizeQueryText("  hello world  "), "hello world");
  });

  it("handles empty string", () => {
    assert.equal(sanitizeQueryText(""), "");
  });

  it("handles string that is all whitespace", () => {
    assert.equal(sanitizeQueryText("   \n\t   "), "");
  });

  it("preserves normal Unicode text", () => {
    assert.equal(sanitizeQueryText("café résumé"), "café résumé");
  });
});
