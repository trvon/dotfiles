/**
 * Tests for the 4-tier context management handler in hybrid-optimizer.ts.
 *
 * Tests tier selection logic, tool output truncation at each tier, thinking
 * block stripping behavior, assistant message capping, structural dedup
 * (duplicate tools/skills/large messages), Tier 2 YAMS chunk retrieval
 * integration via contextChunker.buildOptimizedContext(), and Tier 3
 * emergency message trimming.
 *
 * Follows the same re-implementation pattern as other test files — extracts
 * the context handler logic into testable functions rather than importing
 * the real module (which depends on @mariozechner/pi-coding-agent).
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
} from "./test-helpers.ts";

// ---------------------------------------------------------------------------
// Constants mirroring hybrid-optimizer.ts context management
// ---------------------------------------------------------------------------

// Tier boundaries
const CTX_TIER1_TOKENS = 64000;
const CTX_TIER2_TOKENS = 128000;
const CTX_TIER3_TOKENS = 192000;

// Tier 0 caps (default)
const TOOL_OUTPUT_MAX_CHARS = 8000;
const TOOL_OUTPUT_HEAD_CHARS = 7000;
const TOOL_OUTPUT_TAIL_CHARS = 500;
const CAP_OLD_ASSISTANT_TEXT_CHARS = 1800;
const KEEP_RECENT_ASSISTANT_MESSAGES = 6;

// Tier 1 tighter caps
const TIER1_TOOL_OUTPUT_MAX_CHARS = 4000;
const TIER1_CAP_OLD_ASSISTANT_TEXT_CHARS = 600;
const TIER1_KEEP_RECENT_ASSISTANT_MESSAGES = 4;

// Tier 2
const TIER2_SEMANTIC_KEEP_LAST_N = 30;

// Tier 3
const TIER3_KEEP_LAST_MESSAGES = 8;

// Chunk injection constants (from semantic-compressor.ts)
const CTX_MAX_INJECTED_CHUNKS = 5;
const CTX_MAX_CHUNK_INJECT_CHARS = 1200;

// ---------------------------------------------------------------------------
// Utility helpers (truncateToolOutput is local — depends on test constants)
// ---------------------------------------------------------------------------

function truncateToolOutput(text: string): {
  text: string;
  truncated: boolean;
  originalLength: number;
} {
  if (text.length <= TOOL_OUTPUT_MAX_CHARS)
    return { text, truncated: false, originalLength: text.length };
  const head = text.slice(0, TOOL_OUTPUT_HEAD_CHARS);
  const tail = text.slice(-TOOL_OUTPUT_TAIL_CHARS);
  const marker = `\n\n--- [TRUNCATED: ${text.length.toLocaleString()} chars -> ${(head.length + tail.length + 100).toLocaleString()} chars. Use targeted reads or YAMS search for full content.] ---\n\n`;
  return {
    text: head + marker + tail,
    truncated: true,
    originalLength: text.length,
  };
}

function isToolsBlock(text: string): boolean {
  return text.startsWith("## Sage MCP Tools Available");
}

function extractSkillKey(text: string): string | null {
  if (!text.startsWith("---\n# Skill:")) return null;
  const match = text.match(/^---\s*\n# Skill:\s*([^\n(]+)/i);
  if (!match) return "unknown";
  return match[1].trim().toLowerCase();
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// RetrievedChunk type and ContextChunker (mirrored from semantic-compressor.ts)
// ---------------------------------------------------------------------------

type RetrievedChunk = {
  snippet: string;
  score: number;
  chunkType: string;
};

class ContextChunker {
  private _cachedChunks: RetrievedChunk[] = [];

  getCachedChunks(): RetrievedChunk[] {
    return this._cachedChunks;
  }

  buildOptimizedContext(messages: any[], keepLastN: number): any[] {
    if (messages.length === 0 || this._cachedChunks.length === 0) return messages;

    const safeTail = Math.min(keepLastN, messages.length);
    const tailStart = messages.length - safeTail;

    // If not enough old messages to justify replacing, return as-is
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
    return [...preambleMessages, ...messages.slice(tailStart)];
  }

  setCachedChunks(chunks: RetrievedChunk[]): void {
    this._cachedChunks = chunks;
  }

  stats(): { cachedChunks: number } {
    return { cachedChunks: this._cachedChunks.length };
  }

  invalidate(): void {
    this._cachedChunks = [];
  }

  _reset(): void {
    this._cachedChunks = [];
  }
}

// ---------------------------------------------------------------------------
// The context handler — extracted from hybrid-optimizer.ts lines 2571-2781.
//
// This is the core logic we're testing: tier selection, structural dedup,
// tool output truncation, thinking stripping, assistant capping, Tier 2
// chunk retrieval, and Tier 3 emergency trimming.
//
// NOTE: In the real handler, tool output truncation modifies event.messages
// IN-PLACE (the handler doesn't need to return { messages } for tool
// truncation to take effect). For testability, this extracted version sets
// `mutated = true` on tool truncation so the function returns the result.
// ---------------------------------------------------------------------------

function processContextHandler(
  messages: any[],
  tokens: number,
  chunker: ContextChunker,
): { messages: any[] } | undefined {
  // Determine tier
  const tier =
    tokens >= CTX_TIER3_TOKENS
      ? 3
      : tokens >= CTX_TIER2_TOKENS
        ? 2
        : tokens >= CTX_TIER1_TOKENS
          ? 1
          : 0;

  // Select tier-appropriate caps
  const toolOutputMaxChars =
    tier >= 1 ? TIER1_TOOL_OUTPUT_MAX_CHARS : TOOL_OUTPUT_MAX_CHARS;
  const capOldAssistantChars =
    tier >= 1 ? TIER1_CAP_OLD_ASSISTANT_TEXT_CHARS : CAP_OLD_ASSISTANT_TEXT_CHARS;
  const keepRecentAssistant =
    tier >= 1 ? TIER1_KEEP_RECENT_ASSISTANT_MESSAGES : KEEP_RECENT_ASSISTANT_MESSAGES;
  const stripAllThinking = tier >= 1;

  // --- Tool output truncation ---
  let toolTruncations = 0;
  for (const message of messages) {
    if ((message as any)?.role !== "toolResult" || !Array.isArray((message as any)?.content))
      continue;
    const toolMsg = message as any;
    for (let j = 0; j < toolMsg.content.length; j++) {
      const block = toolMsg.content[j];
      if (
        block?.type === "text" &&
        typeof block.text === "string" &&
        block.text.length > toolOutputMaxChars
      ) {
        const result = truncateToolOutput(block.text);
        // Re-truncate to tier-appropriate cap if needed
        let truncatedText = result.text;
        if (truncatedText.length > toolOutputMaxChars) {
          truncatedText = truncate(truncatedText, toolOutputMaxChars);
        }
        if (truncatedText !== block.text) {
          toolMsg.content[j] = { ...block, text: truncatedText };
          toolTruncations++;
        }
      }
    }
  }

  // --- Structural dedup: tools, skills, large messages ---
  const messageTexts = messages.map((message: any) =>
    extractText(message?.content).trim(),
  );

  let toolsSeen = 0;
  let latestToolsIndex = -1;
  const latestSkillIndexByKey = new Map<string, number>();
  let skillsSeen = 0;
  const latestLargeByHash = new Map<string, number>();

  for (let i = 0; i < messages.length; i += 1) {
    const text = messageTexts[i];
    if (!text) continue;

    if (isToolsBlock(text)) {
      toolsSeen += 1;
      latestToolsIndex = i;
    }

    const skillKey = extractSkillKey(text);
    if (skillKey) {
      skillsSeen += 1;
      latestSkillIndexByKey.set(skillKey, i);
    }

    if (text.length > 6000) {
      latestLargeByHash.set(hashText(text.slice(0, 4000)), i);
    }
  }

  let mutated = toolTruncations > 0; // In-place mutation counts
  const keep = new Array(messages.length).fill(true);

  for (let i = 0; i < messages.length; i += 1) {
    const text = messageTexts[i];
    if (!text) continue;

    if (isToolsBlock(text) && latestToolsIndex >= 0 && i !== latestToolsIndex) {
      keep[i] = false;
      mutated = true;
      continue;
    }

    const skillKey = extractSkillKey(text);
    if (skillKey && latestSkillIndexByKey.get(skillKey) !== i) {
      keep[i] = false;
      mutated = true;
      continue;
    }

    if (text.length > 6000) {
      const key = hashText(text.slice(0, 4000));
      if (latestLargeByHash.get(key) !== i) {
        keep[i] = false;
        mutated = true;
        continue;
      }
    }
  }

  if (toolsSeen > 0 && latestToolsIndex >= 0 && !keep[latestToolsIndex]) {
    keep[latestToolsIndex] = true;
    mutated = true;
  }

  let filtered = messages.filter((_message: any, index: number) => keep[index]);

  // --- Tier 2+: Replace old messages with YAMS-retrieved context chunks ---
  if (tier >= 2) {
    const chunkerStats = chunker.stats();
    if (chunkerStats.cachedChunks > 0) {
      const beforeLen = filtered.length;
      filtered = chunker.buildOptimizedContext(filtered, TIER2_SEMANTIC_KEEP_LAST_N);
      const afterLen = filtered.length;
      if (afterLen !== beforeLen) {
        mutated = true;
      }
    }
  }

  // --- Tier 3: Emergency — keep only last N messages verbatim ---
  if (tier >= 3 && filtered.length > TIER3_KEEP_LAST_MESSAGES) {
    const beforeLen = filtered.length;
    filtered = filtered.slice(filtered.length - TIER3_KEEP_LAST_MESSAGES);
    mutated = true;
  }

  // --- Assistant message processing: thinking strip + old text capping ---
  const assistantIndexes: number[] = [];
  for (let i = 0; i < filtered.length; i += 1) {
    if (filtered[i]?.role === "assistant") assistantIndexes.push(i);
  }
  const keepSet = new Set(
    assistantIndexes.slice(
      Math.max(0, assistantIndexes.length - keepRecentAssistant),
    ),
  );

  const compacted = filtered.map((message: any, index: number) => {
    if (message?.role !== "assistant" || !Array.isArray(message?.content))
      return message;

    const isRecent = keepSet.has(index);
    if (!stripAllThinking && isRecent) return message;

    let changed = false;
    const nextContent = message.content
      .filter((block: any) => {
        if (block?.type === "thinking") {
          // Tier 0: strip only from old messages; Tier 1+: strip from all
          if (stripAllThinking || !isRecent) {
            changed = true;
            return false;
          }
        }
        return true;
      })
      .map((block: any) => {
        // Cap text in old (non-recent) messages
        if (
          !isRecent &&
          block?.type === "text" &&
          typeof block.text === "string" &&
          block.text.length > capOldAssistantChars
        ) {
          changed = true;
          return { ...block, text: truncate(block.text, capOldAssistantChars) };
        }
        return block;
      });

    if (!changed) return message;
    mutated = true;
    return { ...message, content: nextContent };
  });

  if (mutated) {
    return { messages: compacted };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Helper: determine tier from tokens (for readable assertions)
// ---------------------------------------------------------------------------

function determineTier(tokens: number): number {
  return tokens >= CTX_TIER3_TOKENS
    ? 3
    : tokens >= CTX_TIER2_TOKENS
      ? 2
      : tokens >= CTX_TIER1_TOKENS
        ? 1
        : 0;
}

// ---------------------------------------------------------------------------
// Message factories for context-specific scenarios
// ---------------------------------------------------------------------------

function toolsBlockMessage(variant?: string): any {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `## Sage MCP Tools Available\n${variant || "tool1, tool2, tool3"}`,
      },
    ],
  };
}

function skillMessage(skillName: string, body?: string): any {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `---\n# Skill: ${skillName}\n${body || "Skill content here..."}`,
      },
    ],
  };
}

function largeMessage(role: "user" | "assistant", charCount: number, seed?: string): any {
  const padding = (seed || "x").repeat(Math.max(1, Math.ceil(charCount / (seed || "x").length)));
  const text = padding.slice(0, charCount);
  if (role === "user") {
    return { role: "user", content: [{ type: "text", text }] };
  }
  return { role: "assistant", content: [{ type: "text", text }] };
}

function bigToolResult(charCount: number, toolName?: string): any {
  return {
    role: "toolResult",
    content: [{ type: "text", text: "r".repeat(charCount) }],
    toolName: toolName ?? "big_tool",
  };
}

function assistantWithThinking(text: string, thinking: string): any {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking },
      { type: "text", text },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Context Management: Tier selection", () => {
  it("selects Tier 0 for tokens below 64K", () => {
    assert.equal(determineTier(0), 0);
    assert.equal(determineTier(32000), 0);
    assert.equal(determineTier(63999), 0);
  });

  it("selects Tier 1 at exactly 64K tokens", () => {
    assert.equal(determineTier(64000), 1);
  });

  it("selects Tier 1 for tokens between 64K and 128K", () => {
    assert.equal(determineTier(80000), 1);
    assert.equal(determineTier(127999), 1);
  });

  it("selects Tier 2 at exactly 128K tokens", () => {
    assert.equal(determineTier(128000), 2);
  });

  it("selects Tier 2 for tokens between 128K and 192K", () => {
    assert.equal(determineTier(150000), 2);
    assert.equal(determineTier(191999), 2);
  });

  it("selects Tier 3 at exactly 192K tokens", () => {
    assert.equal(determineTier(192000), 3);
  });

  it("selects Tier 3 for tokens above 192K", () => {
    assert.equal(determineTier(250000), 3);
    assert.equal(determineTier(262144), 3);
  });
});

describe("Context Management: Tier 0 — structural dedup", () => {
  let chunker: ContextChunker;

  beforeEach(() => {
    chunker = new ContextChunker();
  });

  it("deduplicates repeated tools blocks, keeping the latest", () => {
    const messages = [
      toolsBlockMessage("v1"),
      userMessage("Hello"),
      toolsBlockMessage("v2"),
      assistantMessage("Reply"),
      toolsBlockMessage("v3"),
    ];
    const result = processContextHandler(messages, 10000, chunker);
    assert.ok(result, "should return mutated messages");
    // Only the last tools block should survive
    const toolBlocks = result!.messages.filter((m: any) =>
      extractText(m?.content).trim().startsWith("## Sage MCP Tools Available"),
    );
    assert.equal(toolBlocks.length, 1);
    assert.ok(extractText(toolBlocks[0].content).includes("v3"));
  });

  it("deduplicates repeated skill blocks by key, keeping the latest", () => {
    const messages = [
      skillMessage("yams", "v1 body"),
      userMessage("do something"),
      skillMessage("yams", "v2 body"),
      assistantMessage("done"),
      skillMessage("sage", "sage body"),
    ];
    const result = processContextHandler(messages, 10000, chunker);
    assert.ok(result, "should return mutated messages");
    const skills = result!.messages.filter((m: any) =>
      extractText(m?.content).trim().startsWith("---\n# Skill:"),
    );
    // Should have 2: latest "yams" and latest "sage"
    assert.equal(skills.length, 2);
    assert.ok(extractText(skills[0].content).includes("v2 body"));
    assert.ok(extractText(skills[1].content).includes("sage body"));
  });

  it("deduplicates large messages (>6000 chars) by hash, keeping the latest", () => {
    const largeText = "a".repeat(7000);
    const msg1 = { role: "user", content: [{ type: "text", text: largeText }] };
    const msg2 = userMessage("small filler");
    const msg3 = { role: "user", content: [{ type: "text", text: largeText }] };
    const messages = [msg1, msg2, msg3];
    const result = processContextHandler(messages, 10000, chunker);
    assert.ok(result, "should return mutated messages");
    const largeOnes = result!.messages.filter(
      (m: any) => extractText(m?.content).length > 6000,
    );
    assert.equal(largeOnes.length, 1, "only one copy of the large message should remain");
  });

  it("returns undefined (no mutation) when no duplicates exist", () => {
    const messages = [
      userMessage("Hello"),
      assistantMessage("Hi there"),
    ];
    const result = processContextHandler(messages, 10000, chunker);
    assert.equal(result, undefined, "no mutation should occur");
  });

  it("preserves thinking blocks in recent assistant messages at Tier 0", () => {
    const messages = [
      userMessage("question"),
      assistantWithThinking("answer 1", "deep thought 1"),
      userMessage("follow-up"),
      assistantWithThinking("answer 2", "deep thought 2"),
    ];
    const result = processContextHandler(messages, 10000, chunker);
    // At Tier 0, recent messages should keep thinking blocks.
    // With only 2 assistant messages and keepRecentAssistant=6, both are recent.
    assert.equal(result, undefined, "no mutation when both are recent at Tier 0");
  });

  it("strips thinking from OLD assistant messages at Tier 0", () => {
    // We need >6 assistant messages so some are old
    const messages: any[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(userMessage(`question ${i}`));
      messages.push(assistantWithThinking(`answer ${i}`, `thinking ${i}`));
    }
    const result = processContextHandler(messages, 10000, chunker);
    assert.ok(result, "should mutate — strip thinking from old messages");
    // First 2 assistant messages (index 1, 3) are old (8 total, keep last 6)
    const firstAssistant = result!.messages.find(
      (m: any) => m.role === "assistant" && extractText(m.content).includes("answer 0"),
    );
    assert.ok(firstAssistant);
    const hasThinking = firstAssistant.content.some(
      (b: any) => b.type === "thinking",
    );
    assert.equal(hasThinking, false, "old assistant should have thinking stripped");
    // Last assistant should still have thinking at Tier 0
    const lastAssistant = result!.messages.find(
      (m: any) => m.role === "assistant" && extractText(m.content).includes("answer 7"),
    );
    assert.ok(lastAssistant);
    const lastHasThinking = lastAssistant.content.some(
      (b: any) => b.type === "thinking",
    );
    assert.equal(lastHasThinking, true, "recent assistant should keep thinking at Tier 0");
  });

  it("truncates tool outputs that exceed TOOL_OUTPUT_MAX_CHARS (8000) at Tier 0", () => {
    const messages = [
      userMessage("run the tool"),
      bigToolResult(12000),
    ];
    const result = processContextHandler(messages, 10000, chunker);
    assert.ok(result, "should mutate — tool output truncated");
    const toolMsg = result!.messages.find((m: any) => m.role === "toolResult");
    assert.ok(toolMsg);
    const text = toolMsg.content[0].text;
    assert.ok(
      text.length <= TOOL_OUTPUT_MAX_CHARS + 200,
      `tool output should be truncated to ~${TOOL_OUTPUT_MAX_CHARS} chars, got ${text.length}`,
    );
  });

  it("does NOT truncate tool outputs <= TOOL_OUTPUT_MAX_CHARS at Tier 0", () => {
    const messages = [
      userMessage("run tool"),
      bigToolResult(7000),
    ];
    const result = processContextHandler(messages, 10000, chunker);
    // No truncation needed, no dedup needed = no mutation
    assert.equal(result, undefined);
  });

  it("caps text in old (non-recent) assistant messages at Tier 0", () => {
    const messages: any[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(userMessage(`q${i}`));
      messages.push(assistantMessage("x".repeat(3000)));
    }
    const result = processContextHandler(messages, 10000, chunker);
    assert.ok(result, "should mutate — old assistant text capped");
    // First assistant (old) should be capped at CAP_OLD_ASSISTANT_TEXT_CHARS
    const firstAssistant = result!.messages[1];
    assert.equal(firstAssistant.role, "assistant");
    const textBlock = firstAssistant.content.find((b: any) => b.type === "text");
    assert.ok(textBlock);
    assert.ok(
      textBlock.text.length <= CAP_OLD_ASSISTANT_TEXT_CHARS,
      `old assistant text should be capped at ${CAP_OLD_ASSISTANT_TEXT_CHARS}, got ${textBlock.text.length}`,
    );
  });
});

describe("Context Management: Tier 1 — tighter caps", () => {
  let chunker: ContextChunker;

  beforeEach(() => {
    chunker = new ContextChunker();
  });

  it("truncates tool outputs to TIER1_TOOL_OUTPUT_MAX_CHARS (4000)", () => {
    const messages = [
      userMessage("run tool"),
      bigToolResult(6000),
    ];
    const result = processContextHandler(messages, 80000, chunker); // Tier 1
    assert.ok(result, "should mutate — tool truncated to tier 1 cap");
    const toolMsg = result!.messages.find((m: any) => m.role === "toolResult");
    assert.ok(toolMsg);
    const text = toolMsg.content[0].text;
    assert.ok(
      text.length <= TIER1_TOOL_OUTPUT_MAX_CHARS,
      `tool output at Tier 1 should be capped at ${TIER1_TOOL_OUTPUT_MAX_CHARS}, got ${text.length}`,
    );
  });

  it("strips thinking from ALL assistant messages (including recent)", () => {
    const messages = [
      userMessage("question"),
      assistantWithThinking("answer", "deep thinking"),
    ];
    const result = processContextHandler(messages, 80000, chunker);
    assert.ok(result, "should mutate — thinking stripped from recent messages at Tier 1");
    const assistant = result!.messages.find((m: any) => m.role === "assistant");
    assert.ok(assistant);
    const hasThinking = assistant.content.some((b: any) => b.type === "thinking");
    assert.equal(hasThinking, false, "Tier 1 should strip thinking from ALL assistant messages");
  });

  it("caps old assistant text at TIER1_CAP_OLD_ASSISTANT_TEXT_CHARS (600)", () => {
    const messages: any[] = [];
    // Need >4 assistants so some are old at Tier 1 (keepRecentAssistant=4)
    for (let i = 0; i < 6; i++) {
      messages.push(userMessage(`q${i}`));
      messages.push(assistantWithThinking("y".repeat(2000), "think"));
    }
    const result = processContextHandler(messages, 80000, chunker);
    assert.ok(result, "should mutate");
    // First assistant message (old at Tier 1) should be capped at 600
    const firstAssistant = result!.messages[1];
    assert.equal(firstAssistant.role, "assistant");
    const textBlock = firstAssistant.content.find((b: any) => b.type === "text");
    assert.ok(textBlock);
    assert.ok(
      textBlock.text.length <= TIER1_CAP_OLD_ASSISTANT_TEXT_CHARS,
      `old assistant text at Tier 1 should be capped at ${TIER1_CAP_OLD_ASSISTANT_TEXT_CHARS}, got ${textBlock.text.length}`,
    );
  });

  it("keeps only last 4 assistant messages as 'recent'", () => {
    const messages: any[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(userMessage(`q${i}`));
      messages.push(assistantMessage("y".repeat(2000)));
    }
    const result = processContextHandler(messages, 80000, chunker);
    assert.ok(result, "should mutate");
    // Count assistant messages with uncapped text (> 600 chars => recent)
    const assistants = result!.messages.filter((m: any) => m.role === "assistant");
    const recentAssistants = assistants.filter((m: any) => {
      const textBlock = m.content.find((b: any) => b.type === "text");
      return textBlock && textBlock.text.length > TIER1_CAP_OLD_ASSISTANT_TEXT_CHARS;
    });
    assert.equal(
      recentAssistants.length,
      TIER1_KEEP_RECENT_ASSISTANT_MESSAGES,
      `should have exactly ${TIER1_KEEP_RECENT_ASSISTANT_MESSAGES} uncapped (recent) assistant messages`,
    );
  });

  it("still performs structural dedup at Tier 1", () => {
    const messages = [
      toolsBlockMessage("v1"),
      userMessage("middle"),
      toolsBlockMessage("v2"),
    ];
    const result = processContextHandler(messages, 80000, chunker);
    assert.ok(result, "should mutate — dedup tools block");
    const toolBlocks = result!.messages.filter((m: any) =>
      extractText(m?.content).trim().startsWith("## Sage MCP Tools Available"),
    );
    assert.equal(toolBlocks.length, 1);
    assert.ok(extractText(toolBlocks[0].content).includes("v2"));
  });
});

describe("Context Management: Tier 2 — YAMS chunk retrieval", () => {
  let chunker: ContextChunker;

  beforeEach(() => {
    chunker = new ContextChunker();
  });

  it("replaces old messages with retrieved chunks when cachedChunks > 0", () => {
    chunker.setCachedChunks([
      { snippet: "Previously the user asked about database schema design", score: 0.85, chunkType: "user-request" },
      { snippet: "The assistant decided to use PostgreSQL for persistence", score: 0.72, chunkType: "decision" },
    ]);

    // Build a conversation with >30 messages so there are old messages to replace
    const messages = generateConversation(20); // 60 messages (user+assistant+toolResult per turn)
    const result = processContextHandler(messages, 150000, chunker); // Tier 2
    assert.ok(result, "should mutate — Tier 2 chunk retrieval active");

    // Should have fewer messages than original (old replaced by preamble)
    assert.ok(
      result!.messages.length < messages.length,
      `result (${result!.messages.length}) should have fewer messages than original (${messages.length})`,
    );

    // Should contain synthetic preamble messages
    const preamble = result!.messages.filter((m: any) =>
      extractText(m?.content).includes("[retrieved context"),
    );
    assert.equal(preamble.length, 2, "should inject 2 retrieved context messages");
  });

  it("preserves the last TIER2_SEMANTIC_KEEP_LAST_N messages", () => {
    chunker.setCachedChunks([
      { snippet: "chunk1", score: 0.9, chunkType: "finding" },
    ]);

    const messages = generateConversation(20); // 60 messages
    const result = processContextHandler(messages, 150000, chunker);
    assert.ok(result);

    // Should keep last 30 + 1 preamble
    const expectedMessages = TIER2_SEMANTIC_KEEP_LAST_N + 1; // 30 tail + 1 chunk
    assert.equal(result!.messages.length, expectedMessages);
  });

  it("does nothing when cachedChunks is empty", () => {
    // No chunks cached — Tier 2 should still apply Tier 1 rules but not chunk retrieval
    const messages: any[] = [];
    for (let i = 0; i < 6; i++) {
      messages.push(userMessage(`q${i}`));
      messages.push(assistantWithThinking("y".repeat(1000), "thinking"));
    }
    const result = processContextHandler(messages, 150000, chunker);
    // Should still mutate from Tier 1 rules (strip thinking)
    assert.ok(result, "should mutate from Tier 1 thinking strip");
    // Should NOT have retrieved context preamble
    const preamble = result!.messages.filter((m: any) =>
      extractText(m?.content).includes("[retrieved context"),
    );
    assert.equal(preamble.length, 0, "no preamble when no cached chunks");
  });

  it("caps injected chunks at CTX_MAX_INJECTED_CHUNKS (5)", () => {
    const manyChunks: RetrievedChunk[] = [];
    for (let i = 0; i < 10; i++) {
      manyChunks.push({
        snippet: `Chunk ${i} content with enough text`,
        score: 0.9 - i * 0.05,
        chunkType: "finding",
      });
    }
    chunker.setCachedChunks(manyChunks);

    const messages = generateConversation(20);
    const result = processContextHandler(messages, 150000, chunker);
    assert.ok(result);

    const preamble = result!.messages.filter((m: any) =>
      extractText(m?.content).includes("[retrieved context"),
    );
    assert.equal(
      preamble.length,
      CTX_MAX_INJECTED_CHUNKS,
      `should inject at most ${CTX_MAX_INJECTED_CHUNKS} chunks`,
    );
  });

  it("truncates individual chunk snippets at CTX_MAX_CHUNK_INJECT_CHARS (1200)", () => {
    const longSnippet = "w".repeat(2000);
    chunker.setCachedChunks([
      { snippet: longSnippet, score: 0.9, chunkType: "finding" },
    ]);

    const messages = generateConversation(20);
    const result = processContextHandler(messages, 150000, chunker);
    assert.ok(result);

    const preamble = result!.messages.find((m: any) =>
      extractText(m?.content).includes("[retrieved context"),
    );
    assert.ok(preamble);
    const injectedText = extractText(preamble.content);
    // The actual text includes "[retrieved context — ..." prefix plus the truncated snippet
    // The snippet portion should be <= CTX_MAX_CHUNK_INJECT_CHARS
    assert.ok(
      injectedText.length < longSnippet.length,
      `injected chunk text (${injectedText.length}) should be shorter than original (${longSnippet.length})`,
    );
  });

  it("returns messages unchanged when conversation is shorter than keepLastN", () => {
    chunker.setCachedChunks([
      { snippet: "chunk data", score: 0.8, chunkType: "finding" },
    ]);

    // Only 4 messages — less than TIER2_SEMANTIC_KEEP_LAST_N (30)
    const messages = [
      userMessage("q1"),
      assistantWithThinking("a1", "think"),
      userMessage("q2"),
      assistantWithThinking("a2", "think"),
    ];
    const result = processContextHandler(messages, 150000, chunker);
    // Should still mutate (thinking stripped at Tier 1+), but no chunk injection
    assert.ok(result, "should mutate from thinking strip");
    const preamble = result!.messages.filter((m: any) =>
      extractText(m?.content).includes("[retrieved context"),
    );
    assert.equal(preamble.length, 0, "no preamble when conversation is too short");
  });

  it("applies Tier 1 caps in addition to chunk retrieval", () => {
    chunker.setCachedChunks([
      { snippet: "some chunk", score: 0.8, chunkType: "finding" },
    ]);

    const messages = generateConversation(20);
    // Add a big tool result
    messages.push(bigToolResult(6000));
    const result = processContextHandler(messages, 150000, chunker);
    assert.ok(result);

    // Check that tool output is truncated to Tier 1 cap
    const toolMsgs = result!.messages.filter((m: any) => m.role === "toolResult");
    for (const tm of toolMsgs) {
      for (const block of tm.content) {
        if (block.type === "text") {
          assert.ok(
            block.text.length <= TIER1_TOOL_OUTPUT_MAX_CHARS,
            `tool output at Tier 2 should be capped at ${TIER1_TOOL_OUTPUT_MAX_CHARS}`,
          );
        }
      }
    }
  });
});

describe("Context Management: Tier 3 — emergency trimming", () => {
  let chunker: ContextChunker;

  beforeEach(() => {
    chunker = new ContextChunker();
  });

  it("trims messages to last TIER3_KEEP_LAST_MESSAGES (8)", () => {
    const messages = generateConversation(10); // 30 messages
    const result = processContextHandler(messages, 200000, chunker); // Tier 3
    assert.ok(result, "should mutate — emergency trim");
    assert.equal(
      result!.messages.length,
      TIER3_KEEP_LAST_MESSAGES,
      `should keep only ${TIER3_KEEP_LAST_MESSAGES} messages`,
    );
  });

  it("keeps the LAST 8 messages, not the first", () => {
    const messages: any[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(userMessage(`message-${i}`));
    }
    const result = processContextHandler(messages, 200000, chunker);
    assert.ok(result);
    // The first kept message should be message-12 (20 - 8 = 12)
    const firstText = extractText(result!.messages[0]?.content);
    assert.ok(
      firstText.includes("message-12"),
      `first kept message should be message-12, got: ${firstText.slice(0, 50)}`,
    );
    const lastText = extractText(
      result!.messages[result!.messages.length - 1]?.content,
    );
    assert.ok(
      lastText.includes("message-19"),
      `last kept message should be message-19, got: ${lastText.slice(0, 50)}`,
    );
  });

  it("does not trim when messages <= TIER3_KEEP_LAST_MESSAGES", () => {
    const messages = [
      userMessage("q1"),
      assistantWithThinking("a1", "think"),
      userMessage("q2"),
      assistantWithThinking("a2", "think"),
    ];
    const result = processContextHandler(messages, 200000, chunker);
    // Should still strip thinking (Tier 1+) but not trim count
    assert.ok(result, "should mutate from thinking strip");
    assert.equal(result!.messages.length, 4, "should not trim 4 messages");
  });

  it("applies Tier 2 chunk retrieval BEFORE Tier 3 trimming", () => {
    chunker.setCachedChunks([
      { snippet: "retrieved chunk", score: 0.9, chunkType: "decision" },
      { snippet: "another chunk", score: 0.8, chunkType: "finding" },
      { snippet: "third chunk", score: 0.7, chunkType: "user-request" },
    ]);

    const messages = generateConversation(20); // 60 messages
    const result = processContextHandler(messages, 200000, chunker); // Tier 3
    assert.ok(result);

    // After Tier 2: 3 preamble + 30 tail = 33 messages
    // After Tier 3: trimmed to last 8
    assert.equal(result!.messages.length, TIER3_KEEP_LAST_MESSAGES);
  });

  it("strips thinking from all assistant messages at Tier 3", () => {
    const messages: any[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(userMessage(`q${i}`));
      messages.push(assistantWithThinking(`a${i}`, `deep thought ${i}`));
    }
    const result = processContextHandler(messages, 200000, chunker);
    assert.ok(result);
    const assistants = result!.messages.filter((m: any) => m.role === "assistant");
    for (const a of assistants) {
      const hasThinking = a.content?.some((b: any) => b.type === "thinking");
      assert.equal(hasThinking, false, "all thinking should be stripped at Tier 3");
    }
  });

  it("truncates tool outputs to Tier 1 cap (4000) at Tier 3", () => {
    const messages: any[] = [
      userMessage("q1"),
      bigToolResult(6000),
      userMessage("q2"),
      assistantMessage("a1"),
      userMessage("q3"),
      assistantMessage("a2"),
      userMessage("q4"),
      assistantMessage("a3"),
    ];
    const result = processContextHandler(messages, 200000, chunker);
    assert.ok(result);
    const toolMsgs = result!.messages.filter((m: any) => m.role === "toolResult");
    for (const tm of toolMsgs) {
      for (const block of tm.content) {
        if (block.type === "text") {
          assert.ok(
            block.text.length <= TIER1_TOOL_OUTPUT_MAX_CHARS,
            `tool output at Tier 3 should be ≤ ${TIER1_TOOL_OUTPUT_MAX_CHARS}, got ${block.text.length}`,
          );
        }
      }
    }
  });
});

describe("Context Management: edge cases", () => {
  let chunker: ContextChunker;

  beforeEach(() => {
    chunker = new ContextChunker();
  });

  it("handles empty message array", () => {
    const result = processContextHandler([], 10000, chunker);
    assert.equal(result, undefined, "empty array should not mutate");
  });

  it("handles messages with null/undefined content", () => {
    const messages = [
      { role: "user", content: null },
      { role: "assistant", content: undefined },
      userMessage("valid message"),
    ];
    // Should not crash
    const result = processContextHandler(messages, 10000, chunker);
    // May or may not mutate — just shouldn't throw
    assert.ok(true, "should not throw on null content");
  });

  it("handles assistant messages with string content (not array)", () => {
    const messages = [
      userMessage("question"),
      { role: "assistant", content: "plain string response" },
    ];
    const result = processContextHandler(messages, 10000, chunker);
    // String content assistants can't be processed for thinking/capping
    assert.equal(result, undefined, "string-content assistant needs no mutation");
  });

  it("correctly handles the boundary between Tier 0 and Tier 1 thinking behavior", () => {
    const messages = [
      userMessage("question"),
      assistantWithThinking("answer", "my thoughts"),
    ];

    // At Tier 0 (below 64K): single recent assistant keeps thinking
    const tier0 = processContextHandler(messages, 63999, chunker);
    assert.equal(tier0, undefined, "Tier 0 should not strip thinking from recent");

    // At Tier 1 (at 64K): thinking stripped from ALL including recent
    const tier1 = processContextHandler([...messages.map(m => ({...m, content: [...m.content]}))], 64000, chunker);
    assert.ok(tier1, "Tier 1 should strip thinking from recent");
    const assistant = tier1!.messages.find((m: any) => m.role === "assistant");
    assert.ok(assistant);
    const hasThinking = assistant.content.some((b: any) => b.type === "thinking");
    assert.equal(hasThinking, false, "thinking should be stripped at Tier 1");
  });

  it("tool output truncation respects tier-appropriate cap", () => {
    // A tool output of 5000 chars: fits in Tier 0 (8000) but not Tier 1 (4000)
    const messages = [userMessage("go"), bigToolResult(5000)];

    const tier0 = processContextHandler(messages, 10000, chunker);
    assert.equal(tier0, undefined, "5000 chars should not be truncated at Tier 0");

    // Deep copy for Tier 1 test since truncation mutates in-place
    const messages2 = [
      userMessage("go"),
      { role: "toolResult", content: [{ type: "text", text: "r".repeat(5000) }], toolName: "big_tool" },
    ];
    const tier1 = processContextHandler(messages2, 80000, chunker);
    assert.ok(tier1, "5000 chars should be truncated at Tier 1");
    const toolMsg = tier1!.messages.find((m: any) => m.role === "toolResult");
    assert.ok(toolMsg);
    assert.ok(
      toolMsg.content[0].text.length <= TIER1_TOOL_OUTPUT_MAX_CHARS,
      `should truncate to ${TIER1_TOOL_OUTPUT_MAX_CHARS} at Tier 1`,
    );
  });

  it("chunker.invalidate() clears cached chunks for subsequent Tier 2 calls", () => {
    chunker.setCachedChunks([
      { snippet: "cached data", score: 0.9, chunkType: "finding" },
    ]);
    assert.equal(chunker.stats().cachedChunks, 1);

    chunker.invalidate();
    assert.equal(chunker.stats().cachedChunks, 0);

    // After invalidation, Tier 2 should not inject any preamble
    const messages = generateConversation(20);
    const result = processContextHandler(messages, 150000, chunker);
    if (result) {
      const preamble = result.messages.filter((m: any) =>
        extractText(m?.content).includes("[retrieved context"),
      );
      assert.equal(preamble.length, 0, "no preamble after invalidation");
    }
  });

  it("multiple tool results in single message are all truncated", () => {
    const messages = [
      userMessage("run tools"),
      {
        role: "toolResult",
        content: [
          { type: "text", text: "r".repeat(10000) },
          { type: "text", text: "s".repeat(10000) },
        ],
        toolName: "multi_tool",
      },
    ];
    const result = processContextHandler(messages, 10000, chunker); // Tier 0
    assert.ok(result, "should mutate — both blocks truncated");
    const toolMsg = result!.messages.find((m: any) => m.role === "toolResult");
    assert.ok(toolMsg);
    for (const block of toolMsg.content) {
      if (block.type === "text") {
        assert.ok(
          block.text.length <= TOOL_OUTPUT_MAX_CHARS + 200,
          `each block should be truncated at Tier 0, got ${block.text.length}`,
        );
      }
    }
  });

  it("structural dedup + tier processing work together", () => {
    // Combine: duplicate tools block + duplicate skill + Tier 1 thinking strip
    const messages = [
      toolsBlockMessage("v1"),
      skillMessage("yams", "v1"),
      userMessage("q1"),
      assistantWithThinking("a1", "thinking"),
      toolsBlockMessage("v2"),
      skillMessage("yams", "v2"),
      userMessage("q2"),
      assistantWithThinking("a2", "thinking 2"),
    ];
    const result = processContextHandler(messages, 80000, chunker); // Tier 1
    assert.ok(result, "should mutate from dedup + thinking strip");

    // Only latest tools block
    const toolBlocks = result!.messages.filter((m: any) =>
      extractText(m?.content).trim().startsWith("## Sage MCP Tools Available"),
    );
    assert.equal(toolBlocks.length, 1);

    // Only latest yams skill
    const skillBlocks = result!.messages.filter((m: any) =>
      extractText(m?.content).trim().startsWith("---\n# Skill:"),
    );
    assert.equal(skillBlocks.length, 1);

    // All thinking stripped
    const assistants = result!.messages.filter((m: any) => m.role === "assistant");
    for (const a of assistants) {
      if (Array.isArray(a.content)) {
        const hasThinking = a.content.some((b: any) => b.type === "thinking");
        assert.equal(hasThinking, false, "thinking should be stripped at Tier 1");
      }
    }
  });
});

describe("Context Management: ContextChunker.buildOptimizedContext", () => {
  let chunker: ContextChunker;

  beforeEach(() => {
    chunker = new ContextChunker();
  });

  it("returns original messages when no chunks cached", () => {
    const messages = [userMessage("a"), assistantMessage("b")];
    const result = chunker.buildOptimizedContext(messages, 30);
    assert.deepEqual(result, messages);
  });

  it("returns original messages when array is empty", () => {
    chunker.setCachedChunks([{ snippet: "x", score: 0.9, chunkType: "finding" }]);
    const result = chunker.buildOptimizedContext([], 30);
    assert.deepEqual(result, []);
  });

  it("returns original messages when all messages fit in keepLastN", () => {
    chunker.setCachedChunks([{ snippet: "x", score: 0.9, chunkType: "finding" }]);
    const messages = [userMessage("a"), assistantMessage("b")];
    const result = chunker.buildOptimizedContext(messages, 30);
    // 2 messages, keepLastN=30 → tailStart=0 → no old messages to replace
    assert.deepEqual(result, messages);
  });

  it("replaces old messages with preamble when conversation exceeds keepLastN", () => {
    chunker.setCachedChunks([
      { snippet: "historic context", score: 0.85, chunkType: "user-request" },
    ]);

    const messages: any[] = [];
    for (let i = 0; i < 40; i++) {
      messages.push(userMessage(`msg-${i}`));
    }

    const result = chunker.buildOptimizedContext(messages, 30);
    // 1 preamble + 30 tail = 31
    assert.equal(result.length, 31);

    // First message should be the preamble
    const first = extractText(result[0].content);
    assert.ok(first.includes("[retrieved context"));
    assert.ok(first.includes("historic context"));

    // Last message should be msg-39
    const last = extractText(result[result.length - 1].content);
    assert.ok(last.includes("msg-39"));
  });

  it("injects chunk type and score in preamble text", () => {
    chunker.setCachedChunks([
      { snippet: "test snippet", score: 0.723, chunkType: "decision" },
    ]);

    const messages: any[] = [];
    for (let i = 0; i < 40; i++) messages.push(userMessage(`m${i}`));

    const result = chunker.buildOptimizedContext(messages, 30);
    const preambleText = extractText(result[0].content);
    assert.ok(preambleText.includes("decision"), "should include chunk type");
    assert.ok(preambleText.includes("0.723"), "should include formatted score");
  });
});
