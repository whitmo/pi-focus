import { createRequire } from "node:module";

import { SessionManager } from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const packageEntry = new URL(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { prepareCompaction } = await import(
  new URL("./core/compaction/compaction.js", packageEntry)
);

const defaultModel = {
  id: "summary",
  name: "Summary",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
};

const defaultSettings = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 0,
};

export function deferred() {
  let resolvePromise;
  let rejectPromise;
  let settled = false;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    get settled() {
      return settled;
    },
    resolve(value) {
      settled = true;
      resolvePromise(value);
    },
    reject(error) {
      settled = true;
      rejectPromise(error);
    },
  };
}

export async function loadCompactExtension(options = {}) {
  const sessionManager = options.sessionManager ?? SessionManager.inMemory("/tmp/pi-focus");
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const notifications = [];
  const modelCalls = [];
  const authCalls = [];
  const compactCalls = [];
  const timeline = [];
  const auth = options.auth ?? deferred();
  const completion = options.completion ?? deferred();
  const runtime = {
    idle: options.idle ?? true,
    usage: options.usage,
    model: options.model === undefined ? defaultModel : options.model,
  };
  const models = options.models ?? [runtime.model].filter(Boolean);
  const settings = { ...defaultSettings, ...options.compactionSettings };
  const compactions = [];

  await options.setup?.(sessionManager);

  const modelRegistry = {
    find(provider, modelId) {
      return models.find((model) => model.provider === provider && model.id === modelId);
    },
    getApiKeyAndHeaders(model) {
      authCalls.push(model);
      timeline.push("auth");
      return auth.promise;
    },
    complete(model, context, callOptions) {
      modelCalls.push({ model, context, options: callOptions });
      timeline.push("complete");
      return completion.promise;
    },
  };

  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    appendEntry(customType, data) {
      timeline.push(`append:${customType}`);
      sessionManager.appendCustomEntry(customType, data);
    },
  };

  const ctx = {
    cwd: sessionManager.getCwd(),
    mode: "tui",
    hasUI: options.hasUI ?? true,
    sessionManager,
    modelRegistry,
    scopedModels: [],
    signal: undefined,
    ui: {
      notify(message, level = "info") {
        notifications.push({ message, level });
      },
    },
    isIdle() {
      return runtime.idle;
    },
    getContextUsage() {
      return runtime.usage;
    },
    compact(compactOptions = {}) {
      const promise = Promise.resolve().then(() => runNativeCompaction(compactOptions));
      compactions.push(promise);
    },
  };
  Object.defineProperty(ctx, "model", {
    get() {
      return runtime.model;
    },
    set(value) {
      runtime.model = value;
    },
  });

  async function runNativeCompaction(compactOptions) {
    const branchEntries = sessionManager.buildContextEntries();
    const preparation = prepareCompaction(branchEntries, settings);
    const record = { branchEntries, preparation, result: undefined };
    compactCalls.push(record);
    if (!preparation) {
      compactOptions.onError?.(new Error("Nothing to compact (session too small)"));
      return;
    }

    const handler = handlers.get("session_before_compact");
    let result;
    try {
      result = await handler?.({
        type: "session_before_compact",
        preparation,
        branchEntries,
        reason: "manual",
        willRetry: false,
        signal: new AbortController().signal,
      }, ctx);
    } catch (error) {
      compactOptions.onError?.(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    record.result = result;
    if (result?.cancel) {
      compactOptions.onError?.(new Error("Compaction cancelled"));
      return;
    }
    if (!result?.compaction) return;

    const value = result.compaction;
    const id = sessionManager.appendCompaction(
      value.summary,
      value.firstKeptEntryId,
      value.tokensBefore,
      value.details,
      true,
      value.usage,
    );
    await handlers.get("session_compact")?.({
      type: "session_compact",
      compactionEntry: sessionManager.getEntry(id),
      fromExtension: true,
      reason: "manual",
      willRetry: false,
    }, ctx);
    compactOptions.onComplete?.(value);
  }

  const mod = await jiti.import("../../extensions/compact.ts");
  mod.default(pi);
  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

  return {
    appendToolResult(text = "focus compact: scheduled") {
      sessionManager.appendMessage({
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "focus-compact-call",
          name: "focus_compact",
          arguments: {},
        }],
        api: "openai-completions",
        provider: "test",
        model: "summary",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: Date.now(),
      });
      return sessionManager.appendMessage({
        role: "toolResult",
        toolCallId: "focus-compact-call",
        toolName: "focus_compact",
        content: [{ type: "text", text }],
        isError: false,
        timestamp: Date.now(),
      });
    },
    appendUser(text) {
      return sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
      });
    },
    async flushCompactions() {
      await Promise.allSettled(compactions);
    },
    auth,
    authCalls,
    commands,
    compactCalls,
    completion,
    ctx,
    handlers,
    modelCalls,
    notifications,
    pi,
    runtime,
    sessionManager,
    timeline,
    tools,
  };
}
