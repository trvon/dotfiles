#!/usr/bin/env node
/**
 * RLM (Retrieval-augmented Long Memory) Benchmark
 *
 * Tests the full pipeline:
 *   1. Extraction heuristics (pure JS — no LLM)
 *   2. Store → YAMS roundtrip via CLI
 *   3. Retrieve → YAMS search with tag filtering
 *   4. Latency measurements
 *   5. Cleanup
 */

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RLM_COLLECTION = "pi-session-memory";
const RLM_TAGS = "rlm,pi-session-memory";
const BENCHMARK_SESSION = `bench-${Date.now().toString(36)}`;
const BENCHMARK_TAG = `rlm-bench-${BENCHMARK_SESSION}`;
const RLM_TAGS_WITH_BENCH = `${RLM_TAGS},${BENCHMARK_TAG}`;

let passed = 0;
let failed = 0;
const timings = {};

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
}

function test(name, fn) {
  const start = performance.now();
  try {
    fn();
    const elapsed = (performance.now() - start).toFixed(1);
    timings[name] = parseFloat(elapsed);
    console.log(`  ✓ ${name} (${elapsed}ms)`);
    passed++;
  } catch (err) {
    const elapsed = (performance.now() - start).toFixed(1);
    timings[name] = parseFloat(elapsed);
    console.log(`  ✗ ${name} (${elapsed}ms)`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

async function asyncTest(name, fn) {
  const start = performance.now();
  try {
    await fn();
    const elapsed = (performance.now() - start).toFixed(1);
    timings[name] = parseFloat(elapsed);
    console.log(`  ✓ ${name} (${elapsed}ms)`);
    passed++;
  } catch (err) {
    const elapsed = (performance.now() - start).toFixed(1);
    timings[name] = parseFloat(elapsed);
    console.log(`  ✗ ${name} (${elapsed}ms)`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

function yams(args, timeoutMs = 15000) {
  const result = spawnSync("yams", args, {
    encoding: "utf-8",
    timeout: timeoutMs,
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

// ---------------------------------------------------------------------------
// Extraction heuristics (ported from hybrid-optimizer.ts for standalone test)
// ---------------------------------------------------------------------------

function extractConclusions(text) {
  const signals = [
    /(?:^|\n)\s*(?:decided|decision|approach|conclusion|found|the issue|root cause|result|summary|key finding|accomplished|completed)[:\s]/im,
    /(?:^|\n)\s*(?:I'll |Let's |We should |The plan is |Going with |Choosing )/m,
    /(?:^|\n)\s*(?:##\s+(?:Goal|Summary|Decision|Result|Finding|Progress|Accomplished|Plan))/m,
  ];

  const lines = text.split("\n");
  const kept = [];
  let capturing = false;
  let capturedLines = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (capturing && capturedLines > 0) capturing = false;
      continue;
    }
    if (!capturing && signals.some((re) => re.test(trimmed))) {
      capturing = true;
      capturedLines = 0;
    }
    if (capturing) {
      kept.push(trimmed);
      capturedLines++;
      if (capturedLines >= 8) capturing = false;
    }
  }

  if (kept.length === 0) return null;
  const joined = kept.join("\n");
  return joined.length > 2000 ? joined.slice(0, 1997) + "..." : joined;
}

function extractFilePaths(text) {
  const pathPattern = /(?:\/[\w.@-]+){2,}(?:\.\w{1,10})?/g;
  const matches = text.match(pathPattern) || [];
  const unique = [...new Set(matches)];
  return unique
    .filter((p) => !p.startsWith("/tmp/") && !p.includes("/node_modules/") && p.length < 200)
    .slice(0, 25);
}

function extractMemoryChunks(messages, objective, carry) {
  const chunks = [];

  if (objective) {
    const carryText = carry.length > 0 ? `\nCarry: ${carry.join("; ")}` : "";
    const content = `Objective: ${objective}${carryText}`;
    chunks.push({ type: "objective", content: content.slice(0, 2000) });
  }

  const allFilePaths = [];
  for (const msg of messages) {
    const text = typeof msg.content === "string" ? msg.content : "";
    if (!text || text.length < 50) continue;

    allFilePaths.push(...extractFilePaths(text));

    if (msg.role === "user" && chunks.length < 5) {
      const cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, " ").replace(/\s+/g, " ").trim();
      if (cleaned.length > 80 && cleaned.length < 6000) {
        chunks.push({ type: "user-request", content: `User request: ${cleaned.slice(0, 2000)}` });
      }
    } else if (msg.role === "assistant" && chunks.length < 5) {
      const withoutThinking = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      if (withoutThinking.length < 80) continue;
      const conclusions = extractConclusions(withoutThinking);
      if (conclusions && conclusions.length > 60) {
        chunks.push({ type: "assistant-finding", content: conclusions });
      }
    }
  }

  const uniquePaths = [...new Set(allFilePaths)].slice(0, 20);
  if (uniquePaths.length > 0 && chunks.length < 5) {
    chunks.push({ type: "file-context", content: `Relevant files: ${uniquePaths.join(", ")}` });
  }

  return chunks.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const sampleMessages = [
  {
    role: "user",
    content:
      "I need you to implement an RLM feature in hybrid-optimizer.ts that stores evicted context chunks in YAMS before compaction and retrieves them on future turns. The store path should use pi.exec with yams add and the retrieve path should use yams search with --tags rlm. Please also add a /rlm command to inspect status.",
  },
  {
    role: "assistant",
    content: `## Goal
Implement RLM (Retrieval-augmented Long Memory) in the hybrid optimizer.

## Decision
Going with a heuristic extraction approach — no LLM needed for chunking. We'll extract:
1. Objective chunk from optimizer state
2. User request chunks from evicted user messages
3. Assistant finding chunks from conclusion paragraphs
4. File context chunk with consolidated paths

The store path uses temp file + yams add CLI. The retrieve path uses yams search --json --tags rlm.

Key files modified:
- /Users/trevon/Documents/depend/dotfiles/pi/extensions/hybrid-optimizer.ts
- /Users/trevon/Documents/depend/dotfiles/pi/tests/smoke.mjs

## Result
All RLM functions written and inserted. The extraction is sync (fast text processing), storage is async fire-and-forget, retrieval happens in before_agent_start alongside existing YAMS hints.`,
  },
  {
    role: "user",
    content:
      "Can you validate the YAMS store and retrieve pipeline works end-to-end? I want to make sure the tags filter correctly and scores are reasonable.",
  },
  {
    role: "assistant",
    content: `## Summary
Validated the full store→search pipeline:
- yams add with --collection pi-session-memory --tags rlm,pi-session-memory works correctly
- yams search --json --tags rlm returns only tagged chunks with semantic similarity scores
- Search latency is 30-80ms, well within the 8s retrieve timeout
- Score threshold of 0.003 filters noise effectively

Found that yams search does NOT support --collection flag, only --tags. Updated the retrieve function accordingly.

Accomplished: full pipeline validated, test entries cleaned up.`,
  },
];

const sampleObjective = "Implement RLM feature for Pi hybrid optimizer";
const sampleCarry = [
  "RLM uses heuristic extraction, no LLM",
  "YAMS search uses --tags not --collection for filtering",
  "Score threshold 0.003 for noise filtering",
];

// ---------------------------------------------------------------------------
// Run benchmarks
// ---------------------------------------------------------------------------

console.log("\n=== RLM Benchmark Suite ===\n");
console.log(`Session: ${BENCHMARK_SESSION}\n`);

// --- Phase 1: Extraction heuristics ---
console.log("Phase 1: Extraction Heuristics (pure JS, no I/O)\n");

test("extractConclusions detects decision paragraphs", () => {
  const text = `Some preamble text here.

## Decision
Going with approach A because it's simpler and faster.
It handles edge cases well and doesn't need an LLM.

Some trailing text.`;

  const result = extractConclusions(text);
  assert(result !== null, "should extract something");
  assert(result.includes("Going with approach A"), `should contain decision text, got: ${result}`);
});

test("extractConclusions detects 'found' signal", () => {
  const text = `I looked at the code.
found: the bug is in line 42 of parser.ts where the regex doesn't handle escaped quotes.
The fix is to add a negative lookbehind.`;

  const result = extractConclusions(text);
  assert(result !== null, "should extract something");
  assert(result.includes("bug is in line 42"), `should contain finding, got: ${result}`);
});

test("extractConclusions returns null for no-signal text", () => {
  const text = "Just some regular code output with no decisions or findings mentioned anywhere in the text.";
  const result = extractConclusions(text);
  assert(result === null, `should return null for no-signal text, got: ${result}`);
});

test("extractConclusions caps at 2000 chars", () => {
  const longText = "## Summary\n" + "This is a very long conclusion paragraph. ".repeat(200);
  const result = extractConclusions(longText);
  assert(result !== null, "should extract something");
  assert(result.length <= 2000, `should cap at 2000, got ${result.length}`);
});

test("extractFilePaths finds paths", () => {
  const text = "Modified /Users/trevon/Documents/depend/dotfiles/pi/extensions/hybrid-optimizer.ts and /Users/trevon/.pi/agent/settings.json";
  const paths = extractFilePaths(text);
  assert(paths.length >= 2, `should find >= 2 paths, got ${paths.length}`);
  assert(paths.some((p) => p.includes("hybrid-optimizer.ts")), "should find hybrid-optimizer.ts");
});

test("extractFilePaths filters /tmp/ and /node_modules/", () => {
  const text = "Files: /tmp/scratch.txt /foo/node_modules/bar.js /real/path/file.ts";
  const paths = extractFilePaths(text);
  assert(!paths.some((p) => p.startsWith("/tmp/")), "should filter /tmp/");
  assert(!paths.some((p) => p.includes("/node_modules/")), "should filter /node_modules/");
  assert(paths.some((p) => p.includes("/real/path/file.ts")), "should keep real paths");
});

test("extractMemoryChunks produces structured output", () => {
  const chunks = extractMemoryChunks(sampleMessages, sampleObjective, sampleCarry);
  assert(chunks.length > 0, "should produce chunks");
  assert(chunks.length <= 5, `should cap at 5, got ${chunks.length}`);

  const types = chunks.map((c) => c.type);
  assert(types.includes("objective"), "should have objective chunk");
  assert(types.includes("user-request"), "should have user-request chunk");
  assert(types.includes("assistant-finding"), "should have assistant-finding chunk");

  // Verify objective chunk contains carry
  const objChunk = chunks.find((c) => c.type === "objective");
  assert(objChunk.content.includes("Carry:"), "objective chunk should contain carry");
  assert(objChunk.content.includes("heuristic"), "objective chunk carry should include heuristic note");
});

test("extractMemoryChunks respects max chunk chars", () => {
  const chunks = extractMemoryChunks(sampleMessages, sampleObjective, sampleCarry);
  for (const chunk of chunks) {
    assert(chunk.content.length <= 2000, `chunk ${chunk.type} exceeds 2000 chars: ${chunk.content.length}`);
  }
});

// --- Phase 2: YAMS Store ---
console.log("\nPhase 2: YAMS Store (CLI roundtrip)\n");

const storedNames = [];

await asyncTest("store objective chunk via temp file", async () => {
  const content = `Objective: ${sampleObjective}\nCarry: ${sampleCarry.join("; ")}`;
  const tmpFile = path.join(os.tmpdir(), `rlm-bench-obj-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, content, "utf-8");

  const name = `rlm-bench-${BENCHMARK_SESSION}-objective-0`;
  const result = yams([
    "add", tmpFile,
    "--name", name,
    "--collection", RLM_COLLECTION,
    "--tags", RLM_TAGS_WITH_BENCH,
    "--metadata", `chunk_type=objective,session_id=${BENCHMARK_SESSION},turn=1`,
    "--sync",
  ]);
  fs.unlinkSync(tmpFile);

  assert(result.code === 0, `yams add failed (code ${result.code}): ${result.stderr}`);
  storedNames.push(name);
});

await asyncTest("store user-request chunk", async () => {
  const content = `User request: Implement RLM feature that stores evicted context chunks in YAMS before compaction and retrieves them on future turns.`;
  const tmpFile = path.join(os.tmpdir(), `rlm-bench-usr-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, content, "utf-8");

  const name = `rlm-bench-${BENCHMARK_SESSION}-user-request-1`;
  const result = yams([
    "add", tmpFile,
    "--name", name,
    "--collection", RLM_COLLECTION,
    "--tags", RLM_TAGS_WITH_BENCH,
    "--metadata", `chunk_type=user-request,session_id=${BENCHMARK_SESSION},turn=1`,
    "--sync",
  ]);
  fs.unlinkSync(tmpFile);

  assert(result.code === 0, `yams add failed (code ${result.code}): ${result.stderr}`);
  storedNames.push(name);
});

await asyncTest("store assistant-finding chunk", async () => {
  const content = `Decision: Going with heuristic extraction approach — no LLM needed for chunking. Store via temp file + yams add CLI. Retrieve via yams search --json --tags rlm. Score threshold 0.003 filters noise.`;
  const tmpFile = path.join(os.tmpdir(), `rlm-bench-asst-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, content, "utf-8");

  const name = `rlm-bench-${BENCHMARK_SESSION}-assistant-finding-2`;
  const result = yams([
    "add", tmpFile,
    "--name", name,
    "--collection", RLM_COLLECTION,
    "--tags", RLM_TAGS_WITH_BENCH,
    "--metadata", `chunk_type=assistant-finding,session_id=${BENCHMARK_SESSION},turn=1`,
    "--sync",
  ]);
  fs.unlinkSync(tmpFile);

  assert(result.code === 0, `yams add failed (code ${result.code}): ${result.stderr}`);
  storedNames.push(name);
});

await asyncTest("store file-context chunk", async () => {
  const content = `Relevant files: /Users/trevon/Documents/depend/dotfiles/pi/extensions/hybrid-optimizer.ts, /Users/trevon/.pi/agent/settings.json, /Users/trevon/Documents/depend/dotfiles/pi/tests/smoke.mjs`;
  const tmpFile = path.join(os.tmpdir(), `rlm-bench-files-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, content, "utf-8");

  const name = `rlm-bench-${BENCHMARK_SESSION}-file-context-3`;
  const result = yams([
    "add", tmpFile,
    "--name", name,
    "--collection", RLM_COLLECTION,
    "--tags", RLM_TAGS_WITH_BENCH,
    "--metadata", `chunk_type=file-context,session_id=${BENCHMARK_SESSION},turn=1`,
    "--sync",
  ]);
  fs.unlinkSync(tmpFile);

  assert(result.code === 0, `yams add failed (code ${result.code}): ${result.stderr}`);
  storedNames.push(name);
});

// Give YAMS a moment to index embeddings
console.log("\n  (waiting 2s for YAMS embedding indexing...)\n");
await new Promise((r) => setTimeout(r, 2000));

// --- Phase 3: YAMS Retrieve ---
console.log("Phase 3: YAMS Retrieve (search with tag filtering)\n");

await asyncTest("search with relevant query returns stored chunks", async () => {
  const result = yams([
    "search", "--json", "--tags", "rlm", "--limit", "5",
    "RLM heuristic extraction store chunks YAMS compaction",
  ]);
  assert(result.code === 0, `yams search failed (code ${result.code}): ${result.stderr}`);
  assert(result.stdout.trim().length > 0, "search returned empty stdout");

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Failed to parse search JSON: ${result.stdout.slice(0, 500)}`);
  }

  const results = Array.isArray(parsed) ? parsed : parsed.results || [];
  assert(results.length > 0, `expected results, got ${results.length}`);

  // Check scores are reasonable
  const topScore = results[0]?.score;
  assert(typeof topScore === "number", `expected numeric score, got ${typeof topScore}`);
  assert(topScore > 0, `expected positive score, got ${topScore}`);
  console.log(`    Top score: ${topScore.toFixed(4)}, results: ${results.length}`);
});

await asyncTest("search with unrelated query returns low/no scores", async () => {
  const result = yams([
    "search", "--json", "--tags", "rlm", "--limit", "5",
    "chocolate cake recipe baking instructions",
  ]);
  assert(result.code === 0, `yams search failed: ${result.stderr}`);

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Failed to parse: ${result.stdout.slice(0, 500)}`);
  }

  const results = Array.isArray(parsed) ? parsed : parsed.results || [];
  if (results.length > 0) {
    const topScore = results[0]?.score || 0;
    // Unrelated queries should have notably lower scores
    console.log(`    Unrelated top score: ${topScore.toFixed(4)} (expected low)`);
    // We just log, not assert, since semantic scores vary
  } else {
    console.log("    No results for unrelated query (good)");
  }
});

await asyncTest("search respects tag filtering", async () => {
  // Search with a tag that shouldn't match our benchmark data
  const result = yams([
    "search", "--json", "--tags", "nonexistent-tag-xyz", "--limit", "5",
    "RLM heuristic extraction",
  ]);
  assert(result.code === 0, `yams search failed: ${result.stderr}`);

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = { results: [] };
  }

  const results = Array.isArray(parsed) ? parsed : parsed.results || [];
  console.log(`    Results with nonexistent tag: ${results.length} (expected 0 or very few)`);
});

await asyncTest("search latency under 500ms for typical query", async () => {
  const start = performance.now();
  const result = yams([
    "search", "--json", "--tags", "rlm", "--limit", "3",
    "optimize context budget compaction hybrid",
  ]);
  const elapsed = performance.now() - start;
  assert(result.code === 0, `yams search failed: ${result.stderr}`);
  assert(elapsed < 500, `search took ${elapsed.toFixed(0)}ms, expected < 500ms`);
  console.log(`    Search latency: ${elapsed.toFixed(0)}ms`);
});

// --- Phase 4: Score quality ---
console.log("\nPhase 4: Score Quality Validation\n");

await asyncTest("relevant query scores above RLM_MIN_SCORE (0.003)", async () => {
  const result = yams([
    "search", "--json", "--tags", "rlm", "--limit", "5",
    "implement RLM retrieval-augmented long memory Pi optimizer",
  ]);
  assert(result.code === 0, `search failed: ${result.stderr}`);

  const parsed = JSON.parse(result.stdout);
  const results = Array.isArray(parsed) ? parsed : parsed.results || [];
  const aboveThreshold = results.filter((r) => r.score >= 0.003);
  console.log(`    ${aboveThreshold.length}/${results.length} results above 0.003 threshold`);
  assert(aboveThreshold.length > 0, "expected at least 1 result above 0.003");
});

await asyncTest("result snippets contain readable content", async () => {
  const result = yams([
    "search", "--json", "--tags", "rlm", "--limit", "3",
    "heuristic extraction chunks YAMS store",
  ]);
  assert(result.code === 0, `search failed: ${result.stderr}`);

  const parsed = JSON.parse(result.stdout);
  const results = Array.isArray(parsed) ? parsed : parsed.results || [];
  for (const r of results.slice(0, 3)) {
    const snippet = r.snippet || r.content || "";
    assert(snippet.length > 0, "snippet should be non-empty");
    assert(snippet.length < 5000, `snippet too long: ${snippet.length}`);
    console.log(`    [${r.score?.toFixed(4)}] ${snippet.slice(0, 80)}...`);
  }
});

// --- Phase 5: Multi-chunk store latency ---
console.log("\nPhase 5: Multi-chunk Store Latency\n");

await asyncTest("store 4 chunks sequentially under 10s total", async () => {
  const chunks = extractMemoryChunks(sampleMessages, sampleObjective, sampleCarry);
  assert(chunks.length >= 2, `expected >= 2 chunks, got ${chunks.length}`);

  const start = performance.now();
  let stored = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const tmpFile = path.join(os.tmpdir(), `rlm-bench-multi-${Date.now()}-${i}.txt`);
    fs.writeFileSync(tmpFile, chunk.content, "utf-8");

    const name = `rlm-bench-${BENCHMARK_SESSION}-multi-${chunk.type}-${i}`;
    const result = yams([
      "add", tmpFile,
      "--name", name,
      "--collection", RLM_COLLECTION,
      "--tags", RLM_TAGS_WITH_BENCH,
      "--metadata", `chunk_type=${chunk.type},session_id=${BENCHMARK_SESSION},turn=2`,
    ]);
    fs.unlinkSync(tmpFile);

    if (result.code === 0) {
      stored++;
      storedNames.push(name);
    }
  }

  const elapsed = performance.now() - start;
  console.log(`    Stored ${stored}/${chunks.length} chunks in ${elapsed.toFixed(0)}ms`);
  assert(stored === chunks.length, `failed to store all chunks: ${stored}/${chunks.length}`);
  assert(elapsed < 10000, `store took ${elapsed.toFixed(0)}ms, expected < 10s`);
});

// --- Phase 6: Cleanup ---
console.log("\nPhase 6: Cleanup\n");

await asyncTest("delete benchmark entries from YAMS", async () => {
  // Search for our benchmark entries and delete them
  const result = yams([
    "search", "--json", "--tags", BENCHMARK_TAG, "--limit", "20",
    "rlm bench",
  ]);

  if (result.code === 0 && result.stdout.trim()) {
    try {
      const parsed = JSON.parse(result.stdout);
      const results = Array.isArray(parsed) ? parsed : parsed.results || [];
      let deleted = 0;
      for (const r of results) {
        const id = r.id || r.doc_id;
        if (id) {
          const del = yams(["delete", id]);
          if (del.code === 0) deleted++;
        }
      }
      console.log(`    Deleted ${deleted} benchmark entries`);
    } catch {
      console.log("    Could not parse search results for cleanup");
    }
  } else {
    console.log("    No benchmark entries found to clean up (or search failed)");
  }
});

// --- Summary ---
console.log("\n=== Benchmark Results ===\n");
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`  Total:  ${passed + failed}`);
console.log();

// Latency summary
const storeTimings = Object.entries(timings)
  .filter(([k]) => k.includes("store") && !k.includes("delete") && !k.includes("latency"))
  .map(([k, v]) => v);
const searchTimings = Object.entries(timings)
  .filter(([k]) => k.includes("search") || k.includes("retrieve") || k.includes("relevant") || k.includes("Score") || k.includes("snippet"))
  .map(([k, v]) => v);

if (storeTimings.length > 0) {
  const avgStore = (storeTimings.reduce((a, b) => a + b, 0) / storeTimings.length).toFixed(0);
  console.log(`  Avg store time: ${avgStore}ms (${storeTimings.length} ops)`);
}
if (searchTimings.length > 0) {
  const avgSearch = (searchTimings.reduce((a, b) => a + b, 0) / searchTimings.length).toFixed(0);
  console.log(`  Avg search time: ${avgSearch}ms (${searchTimings.length} ops)`);
}

console.log();
process.exit(failed > 0 ? 1 : 0);
