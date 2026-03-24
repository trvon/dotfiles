#!/usr/bin/env node --experimental-strip-types
/**
 * Integration validation script for semantic-compressor.ts + YAMS.
 *
 * This is NOT a unit test — it exercises the real YAMS CLI to validate
 * the chunk storage → retrieval → context build pipeline end-to-end.
 *
 * Run: node --experimental-strip-types extensions/tests/integration-validation.ts
 *
 * Prerequisites:
 *   - YAMS daemon running (yams status should show "ready")
 *   - pi-session-memory collection exists
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID = `integ-test-${Date.now().toString(36)}`;
const COLLECTION = "pi-session-memory";
const GLOBAL_TAG = process.env.PI_CHUNK_GLOBAL_TAG || "rlm-semantic";
const TAGS_BASE = `${GLOBAL_TAG},pi-session-memory`;
const MIN_SCORE = 0.003;
const SIMILARITY = "0.001";

let passCount = 0;
let failCount = 0;

function pass(label: string): void {
  passCount++;
  console.log(`  [PASS] ${label}`);
}

function fail(label: string, detail: string): void {
  failCount++;
  console.error(`  [FAIL] ${label}: ${detail}`);
}

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    pass(label);
  } else {
    fail(label, detail || "assertion failed");
  }
}

function shellEscape(arg: string): string {
  // If arg contains special chars, wrap in single quotes and escape internal single quotes
  if (/[^a-zA-Z0-9_\-.,/:=@]/.test(arg)) {
    return `'${arg.replace(/'/g, "'\\''")}'`;
  }
  return arg;
}

function yams(args: string[], timeout = 15000): { code: number; stdout: string; stderr: string } {
  const cmd = `yams ${args.map(shellEscape).join(" ")}`;
  try {
    const stdout = execSync(cmd, {
      encoding: "utf-8",
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err: any) {
    return {
      code: err.status ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(err),
    };
  }
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

// Mirrors storeChunk from semantic-compressor.ts
function storeChunk(
  name: string,
  content: string,
  metadata: string,
): boolean {
  const tmpFile = path.join(
    tmpdir(),
    `pi-integ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
  );
  const tags = `${TAGS_BASE},session:${SESSION_ID}`;
  try {
    fs.writeFileSync(tmpFile, content, "utf-8");
    const result = yams([
      "add",
      tmpFile,
      "--name", name,
      "--collection", COLLECTION,
      "--tags", tags,
      "--metadata", metadata,
    ]);
    return result.code === 0;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// Mirrors parseSearchResults from semantic-compressor.ts
type RetrievedChunk = { snippet: string; score: number; chunkType: string };

function parseSearchResults(stdout: string, seenIds: Set<string>): RetrievedChunk[] {
  try {
    const parsed = JSON.parse(stdout);
    const results: any[] = Array.isArray(parsed) ? parsed : parsed.results || [];
    const chunks: RetrievedChunk[] = [];
    for (const r of results) {
      if (typeof r.score === "number" && r.score >= MIN_SCORE && !seenIds.has(r.id)) {
        seenIds.add(r.id);

        // Extract chunk type: prefer metadata, fall back to name/path pattern
        let chunkType = r.metadata?.chunk_type;
        if (!chunkType && typeof r.path === "string") {
          const pathMatch = r.path.match(/pi-ctx-[^-]+-t\d+-([\w-]+)-\d+/);
          if (pathMatch) chunkType = pathMatch[1];
        }

        chunks.push({
          snippet: (r.snippet || "").replace(/\s+/g, " ").trim(),
          score: r.score,
          chunkType: chunkType || "unknown",
        });
      }
    }
    return chunks;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Test: extractTurnChunks logic (mirrors semantic-compressor.ts)
// ---------------------------------------------------------------------------

type ChunkType =
  | "objective" | "user-request" | "assistant-finding"
  | "file-context" | "tool-outcome" | "code-change" | "decision";

type ContextChunk = { type: ChunkType; content: string };

function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const c of content) {
    if (typeof c === "string") { out.push(c); continue; }
    if (!c || typeof c !== "object") continue;
    if (typeof c.text === "string") out.push(c.text);
    if (typeof c.content === "string") out.push(c.content);
  }
  return out.join("\n");
}

function extractTurnChunks(messages: any[], maxChunks: number): ContextChunk[] {
  const chunks: ContextChunk[] = [];
  for (const msg of messages) {
    if (chunks.length >= maxChunks) break;
    const role = msg?.role;
    if (role === "user") {
      let text = extractText(msg?.content)
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
        .trim();
      if (text.length >= 60) {
        chunks.push({ type: "user-request", content: truncate(text, 2000) });
      }
    } else if (role === "assistant") {
      const content = msg?.content;
      let text = "";
      if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content) {
          if (block?.type === "text" && typeof block.text === "string") {
            parts.push(block.text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim());
          }
        }
        text = parts.join("\n").trim();
      } else {
        text = extractText(content);
      }
      if (text.length >= 60) {
        // Check for decision markers
        const lower = text.toLowerCase();
        const isDecision = /\b(decided|chosen to|the root cause is|instead of|switching from)\b/i.test(lower);
        if (isDecision && chunks.length < maxChunks) {
          chunks.push({ type: "decision", content: truncate(text, 2000) });
        }
        // Check for code changes
        const isCodeChange = /\b(created|modified|updated|wrote|rewrote|added|deleted|removed)\s+(file|function|class|module|component)/i.test(lower);
        if (isCodeChange && chunks.length < maxChunks) {
          chunks.push({ type: "code-change", content: truncate(text, 2000) });
        }
        // Always add as finding if substantive
        if (chunks.length < maxChunks) {
          chunks.push({ type: "assistant-finding", content: truncate(text, 2000) });
        }
      }
    } else if (role === "toolResult") {
      const text = extractText(msg?.content);
      if (text.length >= 60 && text.length <= 4000) {
        chunks.push({ type: "tool-outcome", content: truncate(text, 2000) });
      }
    }
  }
  return chunks.slice(0, maxChunks);
}

// Mirrors buildRetrievalQuery from semantic-compressor.ts
function buildRetrievalQuery(messages: any[]): string {
  const parts: string[] = [];
  for (let i = messages.length - 1; i >= 0 && parts.length < 3; i--) {
    const msg = messages[i];
    const role = msg?.role;
    if (role === "user") {
      const text = extractText(msg.content)
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
        .trim();
      if (text.length > 30) parts.push(text.slice(0, 400));
    } else if (role === "assistant") {
      const text = extractText(msg.content)
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .trim();
      if (text.length > 50) parts.push(text.slice(0, 300));
    }
  }
  return parts.join(" ").slice(0, 900);
}

// ---------------------------------------------------------------------------
// Integration test pipeline
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n=== Integration Validation: semantic-compressor → YAMS ===`);
  console.log(`Session: ${SESSION_ID}\n`);

  // -----------------------------------------------------------------------
  // Phase 1: Verify YAMS connectivity
  // -----------------------------------------------------------------------
  console.log("--- Phase 1: YAMS Connectivity ---");

  const statusResult = yams(["--version"]);
  const yamlReady = statusResult.code === 0 && statusResult.stdout.includes("0.");
  assert(yamlReady, "YAMS CLI is available",
    `code=${statusResult.code} stdout=${statusResult.stdout.slice(0, 100)}`);

  if (!yamlReady) {
    console.error("\nYAMS CLI not available. Aborting integration test.");
    process.exit(1);
  }

  // -----------------------------------------------------------------------
  // Phase 2: Simulate a multi-turn conversation and extract chunks
  // -----------------------------------------------------------------------
  console.log("\n--- Phase 2: Chunk Extraction ---");

  const conversation = [
    { role: "user", content: [{ type: "text", text: "Please help me fix the compaction timeout issue. The setTimeout(60s) fires before the 9b model finishes summarization which takes about 72 seconds on average." }] },
    { role: "assistant", content: [
      { type: "thinking", thinking: "Let me analyze the compaction timing..." },
      { type: "text", text: "I've identified the root cause — the 60s setTimeout is too aggressive for the 9b model which averages 72s for summarization. I've decided to switch from a fixed timeout to polling-based completion detection. Instead of setTimeout, we'll poll ctx.getContextUsage() every 5 seconds and only declare stall after 5 minutes of no token count change." },
    ]},
    { role: "toolResult", content: [{ type: "text", text: "Modified file: extensions/hybrid-optimizer.ts\nLines changed: 85-120\nReplaced: setTimeout(resolveCompaction, COMPACTION_TIMEOUT_MS)\nWith: setInterval polling loop with stall detection threshold of 300000ms" }], toolName: "edit_file" },
    { role: "user", content: [{ type: "text", text: "Good, now can you also fix the final_tail_pending watchdog suppression issue? The rapid tool_use events keep resetting the grace timer." }] },
    { role: "assistant", content: [
      { type: "text", text: "I've added a 60-second hard cap on the final_tail_pending total duration. The bug was that rapid tool_use events kept resetting the 15s grace timer indefinitely. Now we track finalTailFirstActivatedAt and enforce a FINAL_TAIL_HARD_CAP_MS = 60000 regardless of timer resets. This was created as a new function enforceHardCap() in health-watchdog.ts." },
    ]},
    { role: "toolResult", content: [{ type: "text", text: "Tests passing: 9/9 in bug2-final-tail-hardcap.test.ts\n- sets finalTailFirstActivatedAt on first activation\n- does NOT reset on re-entry\n- fires hard cap after FINAL_TAIL_HARD_CAP_MS\n- hard cap triggers pending termination recovery\n- grace timer fires normally when no hard cap\n- rapid oscillation capped at 60s" }], toolName: "run_tests" },
  ];

  const chunks = extractTurnChunks(conversation, 8);
  assert(chunks.length > 0, "extractTurnChunks produces chunks", `got ${chunks.length}`);
  assert(chunks.length >= 3, "extracts multiple chunk types", `got ${chunks.length} chunks`);

  const types = new Set(chunks.map(c => c.type));
  assert(types.has("user-request"), "extracts user-request chunks");
  assert(types.has("decision") || types.has("assistant-finding"), "extracts decision or finding chunks");

  console.log(`  Extracted ${chunks.length} chunks: [${[...types].join(", ")}]`);

  // -----------------------------------------------------------------------
  // Phase 3: Store chunks in YAMS (mimics storeChunks)
  // -----------------------------------------------------------------------
  console.log("\n--- Phase 3: Chunk Storage via YAMS CLI ---");

  let stored = 0;
  let storeFailed = 0;
  const turnNumber = 1;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const name = `pi-ctx-${SESSION_ID}-t${turnNumber}-${chunk.type}-${i}`;
    const metadata = `chunk_type=${chunk.type},session_id=${SESSION_ID},turn=${turnNumber}`;
    const ok = storeChunk(name, chunk.content, metadata);
    if (ok) stored++; else storeFailed++;
  }

  assert(stored > 0, "at least one chunk stored successfully", `stored=${stored} failed=${storeFailed}`);
  assert(storeFailed === 0, "no chunk storage failures", `failed=${storeFailed}`);
  console.log(`  Stored: ${stored}, Failed: ${storeFailed}`);

  // Give YAMS time to index and embed
  console.log("  Waiting 4s for YAMS indexing...");
  await new Promise(r => setTimeout(r, 4000));

  // -----------------------------------------------------------------------
  // Phase 4: Retrieve chunks via YAMS search (mimics fetchRelevantChunks)
  // -----------------------------------------------------------------------
  console.log("\n--- Phase 4: Chunk Retrieval ---");

  const query = buildRetrievalQuery(conversation);
  assert(query.length > 30, "buildRetrievalQuery produces meaningful query", `query=${query.length} chars`);
  console.log(`  Query (${query.length} chars): "${query.slice(0, 120)}..."`);

  // Phase 4a: Session-scoped retrieval
  const seenIds = new Set<string>();
  const sessionSearchResult = yams([
    "search", "--json",
    "--tags", `session:${SESSION_ID}`,
    "--similarity", SIMILARITY,
    "--limit", "8",
    query,
  ]);
  assert(sessionSearchResult.code === 0, "session-scoped YAMS search succeeds",
    `code=${sessionSearchResult.code} stderr=${sessionSearchResult.stderr.slice(0, 200)}`);

  const sessionChunks = parseSearchResults(sessionSearchResult.stdout, seenIds);
  console.log(`  Session-scoped results: ${sessionChunks.length} chunks above min score (${MIN_SCORE})`);

  // Phase 4b: Global RLM retrieval
  const remaining = 6 - sessionChunks.length;
  let globalChunks: RetrievedChunk[] = [];
  if (remaining > 0) {
    const globalSearchResult = yams([
      "search", "--json",
      "--tags", GLOBAL_TAG,
      "--similarity", SIMILARITY,
      "--limit", String(remaining + 2),
      query,
    ]);
    assert(globalSearchResult.code === 0, "global RLM YAMS search succeeds",
      `code=${globalSearchResult.code}`);
    globalChunks = parseSearchResults(globalSearchResult.stdout, seenIds);
    console.log(`  Global RLM results: ${globalChunks.length} additional chunks`);
  }

  const allRetrieved = [...sessionChunks, ...globalChunks].slice(0, 6);
  assert(allRetrieved.length > 0, "at least one chunk retrieved",
    `total retrieved: ${allRetrieved.length}`);

  for (const chunk of allRetrieved) {
    console.log(`    score=${chunk.score.toFixed(4)} type=${chunk.chunkType} snippet="${chunk.snippet.slice(0, 80)}..."`);
  }

  // -----------------------------------------------------------------------
  // Phase 5: buildOptimizedContext
  // -----------------------------------------------------------------------
  console.log("\n--- Phase 5: Context Optimization ---");

  const CTX_MAX_INJECTED_CHUNKS = 5;
  const CTX_MAX_CHUNK_INJECT_CHARS = 1200;
  const TIER2_KEEP_LAST_N = 30;

  // Simulate a larger conversation (50 messages) where we'd be at Tier 2
  const bigConversation: any[] = [];
  for (let i = 0; i < 50; i++) {
    bigConversation.push({
      role: i % 3 === 0 ? "user" : i % 3 === 1 ? "assistant" : "toolResult",
      content: [{ type: "text", text: `Message ${i}: ${"x".repeat(100)}` }],
    });
  }

  // Build optimized context (mirrors ContextChunker.buildOptimizedContext)
  const keepLastN = Math.min(TIER2_KEEP_LAST_N, bigConversation.length);
  const tailStart = bigConversation.length - keepLastN;

  let optimizedMessages: any[];
  if (allRetrieved.length > 0 && tailStart > 0) {
    const preamble: any[] = [];
    const usedChunks = allRetrieved.slice(0, CTX_MAX_INJECTED_CHUNKS);
    for (const chunk of usedChunks) {
      const snippetText = truncate(chunk.snippet, CTX_MAX_CHUNK_INJECT_CHARS);
      preamble.push({
        role: "user",
        content: [{
          type: "text",
          text: `[retrieved context — ${chunk.chunkType} (score: ${chunk.score.toFixed(3)})]: ${snippetText}`,
        }],
      });
    }
    optimizedMessages = [...preamble, ...bigConversation.slice(tailStart)];
  } else {
    optimizedMessages = bigConversation;
  }

  assert(optimizedMessages.length < bigConversation.length,
    "optimized context has fewer messages",
    `original=${bigConversation.length} optimized=${optimizedMessages.length}`);

  const preambleCount = optimizedMessages.length - keepLastN;
  assert(preambleCount > 0, "preamble contains retrieved chunks",
    `preamble messages: ${preambleCount}`);

  // Validate preamble format
  const firstPreamble = optimizedMessages[0];
  const firstText = extractText(firstPreamble.content);
  assert(firstText.startsWith("[retrieved context"), "preamble has correct format prefix",
    `got: ${firstText.slice(0, 80)}`);
  assert(firstText.includes("score:"), "preamble includes score",
    `got: ${firstText.slice(0, 120)}`);

  console.log(`  Original: ${bigConversation.length} messages`);
  console.log(`  Optimized: ${optimizedMessages.length} messages (${preambleCount} preamble + ${keepLastN} tail)`);
  console.log(`  Reduction: ${bigConversation.length - optimizedMessages.length} messages dropped`);

  // -----------------------------------------------------------------------
  // Phase 6: Cleanup test data
  // -----------------------------------------------------------------------
  console.log("\n--- Phase 6: Cleanup ---");

  // Delete test chunks by name pattern (use short timeout — yams delete can hang)
  let cleanedUp = 0;
  for (let i = 0; i < chunks.length; i++) {
    const name = `pi-ctx-${SESSION_ID}-t${turnNumber}-${chunks[i].type}-${i}`;
    const result = yams(["delete", "--name", name, "--force"], 5000);
    if (result.code === 0) cleanedUp++;
  }
  console.log(`  Cleaned up ${cleanedUp}/${chunks.length} test chunks (some may timeout — non-critical)`);

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
  if (failCount > 0) {
    process.exit(1);
  } else {
    console.log("All integration checks passed.\n");
  }
}

main().catch((err) => {
  console.error("Integration test crashed:", err);
  process.exit(2);
});
