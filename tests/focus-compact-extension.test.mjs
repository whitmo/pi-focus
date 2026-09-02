import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BOUNDARY_CUSTOM_TYPE,
  MODEL_CUSTOM_TYPE,
  createModelSetting,
} from "../extensions/focus-compact-runtime.mjs";
import { FOCUS_BINDING_CUSTOM_TYPE } from "../extensions/focus-session.mjs";
import { loadCompactExtension } from "./support/focus-compact-fake.mjs";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

const tick = () => new Promise((resolve) => setImmediate(resolve));

function boundaryEntries(sessionManager) {
  return sessionManager.getBranch().filter(
    (entry) => entry.type === "custom" && entry.customType === BOUNDARY_CUSTOM_TYPE,
  );
}

function focusBinding(agentSessionId = "agent-a") {
  const focus = {
    kind: "focus",
    id: "focus-a",
    parentId: null,
    name: "Focus A",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    revision: 1,
    goals: "Ship compaction",
    scope: "Task 2",
    constraints: "Keep the captured focus",
    planningDocs: [],
    refs: [],
    notes: [],
  };
  const active = { focus, subfocus: null };
  return {
    version: 1,
    agentSessionId,
    capturedAt: "2026-09-01T00:00:00.000Z",
    source: "local",
    active,
    last: active,
  };
}

test("exposes the background compaction extension", () => {
  assert.deepEqual(packageJson.pi.extensions, [
    "./extensions/index.ts",
    "./extensions/compact.ts",
  ]);
});

test("registers the command, tool, lifecycle hooks, and one compaction hook", async () => {
  const fake = await loadCompactExtension();

  assert.ok(fake.commands.has("focus-compact"));
  assert.ok(fake.tools.has("focus_compact"));
  assert.ok(fake.handlers.has("session_start"));
  assert.ok(fake.handlers.has("agent_settled"));
  assert.equal([...fake.handlers.keys()].filter((name) => name === "session_before_compact").length, 1);
});

test("idle command captures a boundary and returns before the background model", async () => {
  const fake = await loadCompactExtension();
  fake.appendUser("old context");
  fake.appendUser("recent context");

  const command = fake.commands.get("focus-compact").handler("", fake.ctx);
  await command;
  await fake.flushCompactions();

  assert.equal(boundaryEntries(fake.sessionManager).length, 1);
  assert.equal(fake.authCalls.length, 1);
  assert.equal(fake.auth.settled, false);
  assert.deepEqual(fake.compactCalls[0].result, { cancel: true });
  assert.ok(
    fake.timeline.indexOf(`append:${BOUNDARY_CUSTOM_TYPE}`)
      < fake.timeline.indexOf("auth"),
  );

  fake.auth.resolve({ ok: true, apiKey: "test-key", headers: {} });
  await tick();

  assert.equal(fake.modelCalls.length, 1);
  assert.equal(fake.completion.settled, false);
  assert.equal(fake.modelCalls[0].options.maxTokens, 8192);
  assert.equal(fake.modelCalls[0].options.cacheRetention, "none");
  assert.ok(fake.modelCalls[0].options.signal instanceof AbortSignal);
  assert.equal(typeof fake.modelCalls[0].options.sessionId, "string");
});

test("native-ineligible command reports not enough history without capture", async () => {
  const fake = await loadCompactExtension();

  await fake.commands.get("focus-compact").handler("", fake.ctx);
  await fake.flushCompactions();

  assert.equal(fake.compactCalls.length, 1);
  assert.equal(fake.compactCalls[0].preparation, undefined);
  assert.equal(boundaryEntries(fake.sessionManager).length, 0);
  assert.equal(fake.authCalls.length, 0);
  assert.equal(fake.modelCalls.length, 0);
  assert.match(fake.notifications.at(-1).message, /not enough history/i);
  assert.ok(fake.notifications.at(-1).message.length < 200);
});

test("busy tool schedules once and captures only after its result is on the tape", async () => {
  const fake = await loadCompactExtension({
    compactionSettings: { keepRecentTokens: 10 },
  });
  fake.appendUser("old context");
  fake.appendUser("recent context");
  fake.runtime.idle = false;

  const first = await fake.tools.get("focus_compact").execute(
    "tool-call-1",
    {},
    undefined,
    undefined,
    fake.ctx,
  );
  const second = await fake.tools.get("focus_compact").execute(
    "tool-call-2",
    {},
    undefined,
    undefined,
    fake.ctx,
  );

  assert.match(first.content[0].text, /scheduled/i);
  assert.match(second.content[0].text, /coalesced/i);
  assert.equal(boundaryEntries(fake.sessionManager).length, 0);
  assert.equal(fake.compactCalls.length, 0);

  const toolResultId = fake.appendToolResult(first.content[0].text);
  fake.runtime.idle = true;
  await fake.handlers.get("agent_settled")({ type: "agent_settled" }, fake.ctx);
  await fake.flushCompactions();

  assert.equal(fake.compactCalls.length, 1);
  assert.equal(boundaryEntries(fake.sessionManager).length, 1);
  assert.equal(boundaryEntries(fake.sessionManager)[0].data.preBoundaryLeafId, toolResultId);

  await fake.commands.get("focus-compact").handler("", fake.ctx);
  await fake.handlers.get("agent_settled")({ type: "agent_settled" }, fake.ctx);
  assert.match(fake.notifications.at(-1).message, /coalesced/i);
  assert.equal(fake.compactCalls.length, 1);
});

test("automatic scheduling uses usage and the current model context window", async () => {
  const model = {
    id: "small",
    name: "Small",
    api: "openai-completions",
    provider: "test",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 4096,
  };
  const fake = await loadCompactExtension({
    model,
    usage: { tokens: 75_000, contextWindow: 999_999, percent: 1 },
  });
  fake.appendUser("old context");
  fake.appendUser("recent context");

  await fake.handlers.get("agent_settled")({ type: "agent_settled" }, fake.ctx);
  await fake.flushCompactions();

  assert.equal(fake.compactCalls.length, 1);
  assert.equal(boundaryEntries(fake.sessionManager)[0].data.model, "test:small");
  fake.auth.resolve({ ok: true, apiKey: "test-key", headers: {} });
  await tick();
  assert.equal(fake.modelCalls[0].options.maxTokens, 4096);

  const unavailable = await loadCompactExtension({ usage: undefined });
  unavailable.appendUser("old context");
  unavailable.appendUser("recent context");
  await unavailable.handlers.get("agent_settled")(
    { type: "agent_settled" },
    unavailable.ctx,
  );
  assert.equal(unavailable.compactCalls.length, 0);
});

test("session start aborts and clears older extension-instance work", async () => {
  const fake = await loadCompactExtension();
  fake.appendUser("old context");
  fake.appendUser("recent context");

  await fake.commands.get("focus-compact").handler("", fake.ctx);
  await fake.flushCompactions();
  await fake.handlers.get("session_start")(
    { type: "session_start", reason: "reload" },
    fake.ctx,
  );
  fake.auth.resolve({ ok: true, apiKey: "test-key", headers: {} });
  await tick();

  assert.equal(fake.modelCalls.length, 0);
  await fake.commands.get("focus-compact").handler("", fake.ctx);
  assert.match(fake.notifications.at(-1).message, /scheduled/i);
});

test("capture restores the binding from the full branch, never event.branchEntries", async () => {
  let bindingEntryId;
  const fake = await loadCompactExtension({
    setup(sessionManager) {
      bindingEntryId = sessionManager.appendCustomEntry(
        FOCUS_BINDING_CUSTOM_TYPE,
        focusBinding(sessionManager.getSessionId()),
      );
      sessionManager.appendCustomEntry(
        MODEL_CUSTOM_TYPE,
        createModelSetting("test:summary"),
      );
      sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "summarized old context" }],
        timestamp: Date.now(),
      });
      const keptId = sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "kept context" }],
        timestamp: Date.now(),
      });
      sessionManager.appendCompaction(
        "prior summary",
        keptId,
        100,
        { readFiles: ["prior.md"], modifiedFiles: [] },
      );
      sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "post-compaction context" }],
        timestamp: Date.now(),
      });
      sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "latest context" }],
        timestamp: Date.now(),
      });
    },
  });

  await fake.commands.get("focus-compact").handler("", fake.ctx);
  await fake.flushCompactions();

  assert.equal(
    fake.compactCalls[0].branchEntries.some((entry) => entry.id === bindingEntryId),
    false,
  );
  const boundary = boundaryEntries(fake.sessionManager)[0];
  assert.equal(boundary.data.focusBindingEntryId, bindingEntryId);
  assert.equal(boundary.data.focusBinding.active.focus.id, "focus-a");

  fake.auth.resolve({ ok: true, apiKey: "test-key", headers: {} });
  await tick();
  const prompt = fake.modelCalls[0].context.messages[0].content[0].text;
  assert.match(prompt, /prior summary/);
  assert.match(prompt, /post-compaction context/);
  assert.match(prompt, /focus-a/);
});
