/**
 * Shared test helpers for pi-coding-agent extension tests.
 *
 * Provides mock factories for the `pi` ExtensionAPI, `ctx` ExtensionContext,
 * and various event objects used by extension event handlers.
 */

// ---------------------------------------------------------------------------
// Types matching the pi-coding-agent API surface (duck-typed for testing)
// ---------------------------------------------------------------------------

type MockHandler = (...args: any[]) => any;

type MockPi = {
  on: (event: string, handler: MockHandler) => void;
  registerCommand: (name: string, opts: { description: string; handler: MockHandler }) => void;
  getHandler: (event: string) => MockHandler | undefined;
  getHandlers: (event: string) => MockHandler[];
  getCommand: (name: string) => { description: string; handler: MockHandler } | undefined;
  _handlers: Map<string, MockHandler[]>;
  _commands: Map<string, { description: string; handler: MockHandler }>;
};

type MockModel = {
  id: string;
  contextWindow: number;
  provider?: string;
};

type MockModelRegistry = {
  find: (provider: string, modelId: string) => MockModel | null;
  getApiKey: (model: MockModel) => Promise<string | null>;
  _models: Map<string, MockModel>;
};

type MockUI = {
  notify: (message: string, type?: string) => void;
  setStatus: (key: string, value: string | undefined) => void;
  setWorkingMessage: (message?: string) => void;
  theme: { fg: (style: string, text: string) => string };
  _notifications: Array<{ message: string; type?: string }>;
  _statuses: Map<string, string | undefined>;
};

type MockCtx = {
  model: { id: string; contextWindow: number; provider?: string };
  modelRegistry: MockModelRegistry;
  hasUI: boolean;
  ui: MockUI;
  getContextUsage: () => { tokens: number } | null;
  compact: (opts?: any) => void;
  _compactCalls: any[];
  _setTokens: (tokens: number | null) => void;
};

// ---------------------------------------------------------------------------
// Factory: MockPi
// ---------------------------------------------------------------------------

export function createMockPi(): MockPi {
  const handlers = new Map<string, MockHandler[]>();
  const commands = new Map<string, { description: string; handler: MockHandler }>();

  return {
    on(event: string, handler: MockHandler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name: string, opts: { description: string; handler: MockHandler }) {
      commands.set(name, opts);
    },
    getHandler(event: string): MockHandler | undefined {
      const list = handlers.get(event);
      return list ? list[list.length - 1] : undefined;
    },
    getHandlers(event: string): MockHandler[] {
      return handlers.get(event) || [];
    },
    getCommand(name: string) {
      return commands.get(name);
    },
    _handlers: handlers,
    _commands: commands,
  };
}

// ---------------------------------------------------------------------------
// Factory: MockModelRegistry
// ---------------------------------------------------------------------------

function createMockModelRegistry(
  models?: Array<MockModel & { apiKey?: string }>
): MockModelRegistry {
  const modelMap = new Map<string, MockModel & { apiKey?: string }>();
  for (const m of models ?? []) {
    modelMap.set(`${m.provider || "lmstudio"}:${m.id}`, m);
  }

  return {
    find(provider: string, modelId: string): MockModel | null {
      return modelMap.get(`${provider}:${modelId}`) ?? null;
    },
    async getApiKey(model: MockModel): Promise<string | null> {
      const key = `${model.provider || "lmstudio"}:${model.id}`;
      const entry = modelMap.get(key);
      return entry?.apiKey ?? "test-api-key";
    },
    _models: modelMap as any,
  };
}

// ---------------------------------------------------------------------------
// Factory: MockUI
// ---------------------------------------------------------------------------

function createMockUI(): MockUI {
  const notifications: Array<{ message: string; type?: string }> = [];
  const statuses = new Map<string, string | undefined>();

  return {
    notify(message: string, type?: string) {
      notifications.push({ message, type });
    },
    setStatus(key: string, value: string | undefined) {
      statuses.set(key, value);
    },
    setWorkingMessage(_message?: string) {},
    theme: {
      fg(_style: string, text: string) {
        return text;
      },
    },
    _notifications: notifications,
    _statuses: statuses,
  };
}

// ---------------------------------------------------------------------------
// Factory: MockCtx
// ---------------------------------------------------------------------------

export function createMockCtx(opts?: {
  tokens?: number | null;
  contextWindow?: number;
  modelId?: string;
  hasUI?: boolean;
  models?: Array<MockModel & { apiKey?: string }>;
}): MockCtx {
  const ui = createMockUI();
  const modelRegistry = createMockModelRegistry(opts?.models);
  const model: MockModel = {
    id: opts?.modelId ?? "unsloth/qwen3.5-35b-a3b",
    contextWindow: opts?.contextWindow ?? 262144,
  };
  let tokens: number | null = opts?.tokens ?? null;
  const compactCalls: any[] = [];

  return {
    model,
    modelRegistry,
    hasUI: opts?.hasUI ?? true,
    ui,
    getContextUsage() {
      return tokens !== null ? { tokens } : null;
    },
    compact(compactOpts?: any) {
      compactCalls.push(compactOpts ?? {});
    },
    _compactCalls: compactCalls,
    _setTokens(t: number | null) {
      tokens = t;
    },
  };
}

// ---------------------------------------------------------------------------
// Message & event factories
// ---------------------------------------------------------------------------

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; name: string; arguments?: Record<string, any> };

type MockMessage = {
  role: "user" | "assistant" | "toolResult";
  content: ContentBlock[] | string;
  toolName?: string;
};

export function userMessage(text: string): MockMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

export function assistantMessage(text: string, thinking?: string): MockMessage {
  const content: ContentBlock[] = [];
  if (thinking) content.push({ type: "thinking", thinking });
  content.push({ type: "text", text });
  return { role: "assistant", content };
}

export function toolResultMessage(text: string, toolName?: string): MockMessage {
  return {
    role: "toolResult",
    content: [{ type: "text", text }],
    toolName: toolName ?? "unknown_tool",
  };
}

export function createContextEvent(messages: MockMessage[]) {
  return { messages };
}

function createTurnEndEvent(opts?: {
  stopReason?: string;
  prompt?: string;
}) {
  return {
    message: opts?.stopReason ? { stopReason: opts.stopReason } : {},
    prompt: opts?.prompt ?? "test prompt",
  };
}

function createBeforeAgentStartEvent(opts?: {
  prompt?: string;
  systemPrompt?: string;
  signal?: AbortSignal;
}) {
  return {
    prompt: opts?.prompt ?? "test prompt",
    systemPrompt: opts?.systemPrompt ?? "You are a helpful assistant.",
    signal: opts?.signal,
  };
}

// ---------------------------------------------------------------------------
// Timer utilities
// ---------------------------------------------------------------------------

export function createFakeClock(startTime?: number) {
  let currentTime = startTime ?? 1000000;
  const originalDateNow = Date.now;

  return {
    get now() { return currentTime; },
    advance(ms: number) { currentTime += ms; },
    set(time: number) { currentTime = time; },
    install() { Date.now = () => currentTime; },
    restore() { Date.now = originalDateNow; },
  };
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

export function assertCompactCalled(
  ctx: MockCtx,
  opts?: { minCalls?: number; customInstructionsContains?: string }
): void {
  const minCalls = opts?.minCalls ?? 1;
  if (ctx._compactCalls.length < minCalls) {
    throw new Error(
      `Expected at least ${minCalls} compact() call(s), got ${ctx._compactCalls.length}`
    );
  }
  if (opts?.customInstructionsContains) {
    const found = ctx._compactCalls.some(
      (call: any) =>
        typeof call.customInstructions === "string" &&
        call.customInstructions.includes(opts.customInstructionsContains!)
    );
    if (!found) {
      throw new Error(
        `No compact() call had customInstructions containing "${opts.customInstructionsContains}"`
      );
    }
  }
}

export function assertNotified(
  ctx: MockCtx,
  pattern: string | RegExp,
  type?: string
): void {
  const match = ctx.ui._notifications.some((n) => {
    const textMatch =
      typeof pattern === "string"
        ? n.message.includes(pattern)
        : pattern.test(n.message);
    return textMatch && (type === undefined || n.type === type);
  });
  if (!match) {
    throw new Error(
      `Expected notification matching ${pattern}${type ? ` (type=${type})` : ""}, got: ${JSON.stringify(ctx.ui._notifications)}`
    );
  }
}

export function generateConversation(
  turns: number,
  opts?: { toolResultSize?: number; thinkingSize?: number }
): MockMessage[] {
  const messages: MockMessage[] = [];
  const toolSize = opts?.toolResultSize ?? 200;
  const thinkingSize = opts?.thinkingSize ?? 100;

  for (let i = 0; i < turns; i++) {
    messages.push(userMessage(`User message ${i}: ${"x".repeat(50)}`));
    messages.push(
      assistantMessage(
        `Assistant response ${i}: ${"y".repeat(100)}`,
        "a".repeat(thinkingSize)
      )
    );
    if (toolSize > 0) {
      messages.push(toolResultMessage("z".repeat(toolSize), `tool_${i}`));
    }
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Text extraction & truncation utilities
// ---------------------------------------------------------------------------

/**
 * Extract plain text from a message's content (handles string, array of blocks
 * with text/thinking/content fields).
 */
export function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const chunks: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      chunks.push(block);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    if (typeof block.text === "string") chunks.push(block.text);
    if (typeof block.thinking === "string") chunks.push(block.thinking);
    if (typeof block.content === "string") chunks.push(block.content);
  }
  return chunks.join("\n");
}

/**
 * Truncate text to `limit` characters, appending "..." if truncated.
 */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}
