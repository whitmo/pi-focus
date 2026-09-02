import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BOUNDARY_CUSTOM_TYPE,
  MODEL_CUSTOM_TYPE,
  createCompactionDetails,
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

function contextTexts(sessionManager) {
  return sessionManager.buildSessionContext().messages.map((message) => (
    message.role === "compactionSummary"
      ? message.summary
      : message.content.map((part) => part.text).filter(Boolean).join("\n")
  ));
}

function appendAssistant(sessionManager, text) {
  return sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test",
    model: "summary",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
}

function appendAssistantToolCalls(sessionManager, calls) {
  return sessionManager.appendMessage({
    role: "assistant",
    content: calls.map(({ name, path }, index) => ({
      type: "toolCall",
      id: `call-${index}-${name}`,
      name,
      arguments: { path },
    })),
    api: "openai-completions",
    provider: "test",
    model: "summary",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
}

function summaryResult(text, stopReason = "stop") {
  return {
    content: [{ type: "text", text }],
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
  };
}

function treeEvent(targetId, oldLeafId) {
  return {
    type: "session_before_tree",
    preparation: {
      targetId,
      oldLeafId,
      commonAncestorId: null,
      entriesToSummarize: [],
      userWantsSummary: false,
    },
    signal: new AbortController().signal,
  };
}

function focusBinding(
  agentSessionId = "agent-a",
  focusId = "focus-a",
  subfocusId = null,
) {
  const focus = {
    kind: "focus",
    id: focusId,
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
  const subfocus = subfocusId === null ? null : {
    ...focus,
    kind: "subfocus",
    id: subfocusId,
    parentId: focusId,
    name: "Subfocus A",
  };
  const active = { focus, subfocus };
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
  assert.ok(fake.commands.has("focus-compact-model"));
  assert.ok(fake.commands.has("focus-compact-history"));
  assert.ok(fake.tools.has("focus_compact"));
  assert.ok(fake.handlers.has("session_start"));
  assert.ok(fake.handlers.has("session_before_switch"));
  assert.ok(fake.handlers.has("session_before_fork"));
  assert.ok(fake.handlers.has("session_before_tree"));
  assert.ok(fake.handlers.has("session_shutdown"));
  assert.ok(fake.handlers.has("session_compact"));
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

test("ready summary commits at idle and preserves all post-boundary generations", async () => {
  const fake = await loadCompactExtension();
  fake.appendUser("pre-boundary user");
  appendAssistant(fake.sessionManager, "pre-boundary assistant");

  await fake.commands.get("focus-compact").handler("", fake.ctx);
  await fake.flushCompactions();
  const boundaryId = boundaryEntries(fake.sessionManager)[0].id;

  fake.auth.resolve({ ok: true, apiKey: "test-key", headers: {} });
  await tick();
  fake.appendUser("post-boundary user one");
  appendAssistant(fake.sessionManager, "post-boundary assistant one");
  fake.appendUser("post-boundary user two");
  appendAssistant(fake.sessionManager, "post-boundary assistant two");
  fake.runtime.idle = false;
  fake.completion.resolve(summaryResult("background summary"));
  await tick();

  assert.equal(
    fake.sessionManager.getBranch().some((entry) => entry.type === "compaction"),
    false,
  );

  fake.runtime.idle = true;
  await fake.handlers.get("agent_settled")({ type: "agent_settled" }, fake.ctx);
  await fake.flushCompactions();

  const committed = fake.compactCalls.at(-1).result.compaction;
  assert.equal(committed.firstKeptEntryId, boundaryId);
  assert.deepEqual(
    fake.sessionManager.buildSessionContext().messages.map((message) => (
      message.role === "compactionSummary"
        ? message.summary
        : message.content.map((part) => part.text).filter(Boolean).join("\n")
    )),
    [
      "background summary",
      "post-boundary user one",
      "post-boundary assistant one",
      "post-boundary user two",
      "post-boundary assistant two",
    ],
  );
});

for (const [mismatch, makeStale] of [
  ["session id", (fake) => {
    const captured = fake.sessionManager.getSessionId();
    fake.sessionManager.getSessionId = () => `${captured}-other`;
  }],
  ["session header id", (fake) => {
    const captured = fake.sessionManager.getHeader();
    fake.sessionManager.getHeader = () => ({ ...captured, id: `${captured.id}-other` });
  }],
  ["missing session header", (fake) => {
    fake.sessionManager.getHeader = () => null;
  }],
  ["boundary ancestry", (fake) => {
    const boundary = boundaryEntries(fake.sessionManager)[0];
    fake.sessionManager.branch(boundary.data.preBoundaryLeafId);
  }],
  ["prior compaction id", (fake) => {
    const boundary = boundaryEntries(fake.sessionManager)[0];
    fake.sessionManager.appendCompaction("newer native summary", boundary.id, 50, {});
    fake.appendUser("newer post-compaction user");
    appendAssistant(fake.sessionManager, "newer post-compaction assistant");
  }],
]) {
  test(`rejects a ready result with stale ${mismatch}`, async () => {
    const fake = await loadCompactExtension();
    fake.appendUser("pre-boundary user");
    appendAssistant(fake.sessionManager, "pre-boundary assistant");
    await fake.commands.get("focus-compact").handler("", fake.ctx);
    await fake.flushCompactions();
    fake.auth.resolve({ ok: true, apiKey: "test-key", headers: {} });
    await tick();
    fake.runtime.idle = false;
    fake.completion.resolve(summaryResult("stale summary"));
    await tick();

    makeStale(fake);
    const compactionsBefore = fake.sessionManager.getBranch().filter(
      (entry) => entry.type === "compaction",
    ).length;
    fake.runtime.idle = true;
    await fake.handlers.get("agent_settled")({ type: "agent_settled" }, fake.ctx);
    await fake.flushCompactions();

    assert.equal(
      fake.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length,
      compactionsBefore,
    );
    assert.equal(fake.notifications.some(({ message }) => /complete/i.test(message)), false);
    const notificationCount = fake.notifications.length;
    await fake.commands.get("focus-compact").handler("", fake.ctx);
    assert.equal(
      fake.notifications.slice(notificationCount).some(({ message }) => /scheduled/i.test(message)),
      true,
    );
  });
}

test("a post-boundary focus switch preserves the captured lens and remains on branch", async () => {
  let originalBindingId;
  const fake = await loadCompactExtension({
    setup(sessionManager) {
      originalBindingId = sessionManager.appendCustomEntry(
        FOCUS_BINDING_CUSTOM_TYPE,
        focusBinding(sessionManager.getSessionId(), "focus-a"),
      );
      sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "pre-boundary user" }],
        timestamp: Date.now(),
      });
      appendAssistant(sessionManager, "pre-boundary assistant");
    },
  });

  await fake.commands.get("focus-compact").handler("", fake.ctx);
  await fake.flushCompactions();
  fake.auth.resolve({ ok: true, apiKey: "test-key", headers: {} });
  await tick();
  const switchedBindingId = fake.sessionManager.appendCustomEntry(
    FOCUS_BINDING_CUSTOM_TYPE,
    focusBinding(fake.sessionManager.getSessionId(), "focus-b"),
  );
  fake.appendUser("post-switch work");
  fake.completion.resolve(summaryResult("focus-a summary"));
  await tick();
  await fake.flushCompactions();

  const prompt = fake.modelCalls[0].context.messages[0].content[0].text;
  const committed = fake.sessionManager.getBranch().findLast(
    (entry) => entry.type === "compaction",
  );
  assert.match(prompt, /focus-a/);
  assert.doesNotMatch(prompt, /"id":"focus-b"/);
  assert.equal(committed.details.focusBindingEntryId, originalBindingId);
  assert.equal(committed.details.focusBinding.active.focus.id, "focus-a");
  assert.equal(fake.sessionManager.getBranch().some(({ id }) => id === switchedBindingId), true);
  assert.equal(
    fake.sessionManager.buildSessionContext().messages.at(-1).content[0].text,
    "post-switch work",
  );
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

for (const [hook, event, resolutionStage] of [
  ["session_before_switch", { type: "session_before_switch", reason: "resume" }, "auth"],
  ["session_before_fork", { type: "session_before_fork", entryId: "entry", position: "at" }, "model"],
  ["session_shutdown", { type: "session_shutdown", reason: "reload" }, "model"],
]) {
  test(`${hook} cancels owned work and rejects stale ${resolutionStage} resolution`, async () => {
    const fake = await loadCompactExtension();
    fake.appendUser("old context");
    appendAssistant(fake.sessionManager, "recent context");
    await fake.commands.get("focus-compact").handler("", fake.ctx);
    await fake.flushCompactions();

    if (resolutionStage === "model") {
      fake.auth.resolve({ ok: true, apiKey: "test-key", headers: {} });
      await tick();
    }
    const signal = fake.modelCalls[0]?.options.signal;
    await fake.handlers.get(hook)(event, fake.ctx);
    if (resolutionStage === "auth") {
      fake.auth.resolve({ ok: true, apiKey: "test-key", headers: {} });
    } else {
      fake.completion.resolve(summaryResult("stale lifecycle summary"));
    }
    await tick();
    await fake.flushCompactions();

    if (signal !== undefined) assert.equal(signal.aborted, true);
    assert.equal(fake.modelCalls.length, resolutionStage === "model" ? 1 : 0);
    assert.equal(
      fake.sessionManager.getBranch().some((entry) => entry.type === "compaction"),
      false,
    );
    assert.equal(fake.notifications.some(({ message }) => /complete/i.test(message)), false);
    const notificationCount = fake.notifications.length;
    await fake.commands.get("focus-compact").handler("", fake.ctx);
    assert.equal(
      fake.notifications.slice(notificationCount).some(({ message }) => /scheduled/i.test(message)),
      true,
    );
  });
}

for (const targetKind of ["boundary", "descendant"]) {
  test(`session_before_tree retains work when ${targetKind} is on the boundary branch`, async () => {
    const fake = await loadCompactExtension();
    fake.appendUser("old context");
    appendAssistant(fake.sessionManager, "recent context");
    await fake.commands.get("focus-compact").handler("", fake.ctx);
    await fake.flushCompactions();
    const boundaryId = boundaryEntries(fake.sessionManager)[0].id;
    fake.auth.resolve({ ok: true, apiKey: "test-key", headers: {} });
    await tick();
    const signal = fake.modelCalls[0].options.signal;
    const targetId = targetKind === "boundary"
      ? boundaryId
      : fake.appendUser("target descendant");
    appendAssistant(fake.sessionManager, "current descendant");

    await fake.handlers.get("session_before_tree")(
      treeEvent(targetId, fake.sessionManager.getLeafId()),
      fake.ctx,
    );
    fake.sessionManager.branch(targetId);
    fake.completion.resolve(summaryResult("retained tree summary"));
    await tick();
    await fake.flushCompactions();

    assert.equal(signal.aborted, false);
    assert.equal(
      fake.sessionManager.getBranch().some((entry) => entry.type === "compaction"),
      true,
    );
  });
}

test("session_before_tree aborts work when target branch excludes the boundary", async () => {
  const fake = await loadCompactExtension();
  const ancestorId = fake.appendUser("old context");
  appendAssistant(fake.sessionManager, "recent context");
  await fake.commands.get("focus-compact").handler("", fake.ctx);
  await fake.flushCompactions();
  fake.auth.resolve({ ok: true, apiKey: "test-key", headers: {} });
  await tick();
  const signal = fake.modelCalls[0].options.signal;

  await fake.handlers.get("session_before_tree")(
    treeEvent(ancestorId, fake.sessionManager.getLeafId()),
    fake.ctx,
  );
  fake.sessionManager.branch(ancestorId);
  fake.completion.resolve(summaryResult("stale tree summary"));
  await tick();
  await fake.flushCompactions();

  assert.equal(signal.aborted, true);
  assert.equal(
    fake.sessionManager.getBranch().some((entry) => entry.type === "compaction"),
    false,
  );
});

test("focus-compact-model reports, validates, persists, and disables a session override", async () => {
  const override = {
    id: "small-summary",
    name: "Small Summary",
    api: "openai-completions",
    provider: "test",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 50_000,
    maxTokens: 2048,
  };
  const fake = await loadCompactExtension({ models: [override] });
  const command = fake.commands.get("focus-compact-model");

  await command.handler("", fake.ctx);
  assert.match(fake.notifications.at(-1).message, /current session model/i);

  await command.handler("test:small-summary", fake.ctx);
  assert.deepEqual(fake.sessionManager.getBranch().at(-1).data, {
    version: 1,
    modelKey: "test:small-summary",
  });
  await command.handler("", fake.ctx);
  assert.match(fake.notifications.at(-1).message, /test:small-summary/);

  const entriesBeforeInvalid = fake.sessionManager.getBranch().length;
  await command.handler("invalid", fake.ctx);
  await command.handler("test:missing", fake.ctx);
  assert.equal(fake.sessionManager.getBranch().length, entriesBeforeInvalid);
  assert.equal(
    fake.notifications.slice(-2).every(({ level }) => level === "warning"),
    true,
  );

  await command.handler("off", fake.ctx);
  assert.deepEqual(fake.sessionManager.getBranch().at(-1).data, {
    version: 1,
    modelKey: null,
  });
  await command.handler("", fake.ctx);
  assert.match(fake.notifications.at(-1).message, /current session model/i);
});

test("malformed persisted model setting fails closed and warns on session start", async () => {
  const fake = await loadCompactExtension({
    setup(sessionManager) {
      sessionManager.appendCustomEntry(MODEL_CUSTOM_TYPE, {
        version: 999,
        modelKey: "test:summary",
      });
    },
  });

  assert.equal(
    fake.notifications.filter(({ message }) => /invalid.*model setting/i.test(message)).length,
    1,
  );
  await fake.commands.get("focus-compact-model").handler("", fake.ctx);
  assert.match(fake.notifications.at(-1).message, /current session model/i);
});

test("model override clamps output and rejects oversized input before completion", async () => {
  const override = {
    id: "tiny",
    name: "Tiny",
    api: "openai-completions",
    provider: "test",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 2048,
  };
  const fits = await loadCompactExtension({ models: [override] });
  await fits.commands.get("focus-compact-model").handler("test:tiny", fits.ctx);
  fits.appendUser("old context");
  fits.appendUser("recent context");
  await fits.commands.get("focus-compact").handler("", fits.ctx);
  await fits.flushCompactions();
  fits.auth.resolve({ ok: true, apiKey: "test-key", headers: {} });
  await tick();
  assert.equal(fits.modelCalls[0].options.maxTokens, 2048);

  const oversized = await loadCompactExtension({ models: [override] });
  await oversized.commands.get("focus-compact-model").handler("test:tiny", oversized.ctx);
  oversized.appendUser("x".repeat(40_000));
  oversized.appendUser("recent context");
  await oversized.commands.get("focus-compact").handler("", oversized.ctx);
  await oversized.flushCompactions();
  await tick();
  assert.equal(oversized.modelCalls.length, 0);
  assert.match(oversized.notifications.at(-1).message, /exceeds model context/i);
});

test("focus-compact-history reports bounded newest-first projected details", async () => {
  const fake = await loadCompactExtension({
    setup(sessionManager) {
      const binding = focusBinding(
        sessionManager.getSessionId(),
        "focus-history",
        "subfocus-history",
      );
      const bindingId = sessionManager.appendCustomEntry(
        FOCUS_BINDING_CUSTOM_TYPE,
        binding,
      );
      const keptId = sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "raw secret must not be listed" }],
        timestamp: Date.now(),
      });
      const firstId = sessionManager.appendCompaction(
        "secret older summary",
        keptId,
        100,
        createCompactionDetails({
          jobId: "job-old",
          sessionId: sessionManager.getSessionId(),
          sessionHeaderId: sessionManager.getHeader().id,
          boundaryId: "boundary-old",
          preBoundaryLeafId: keptId,
          priorCompactionId: null,
          focusBinding: { entryId: bindingId, binding },
          trigger: "automatic",
          model: "test:summary",
          startedAt: "2026-09-02T00:00:00.000Z",
          completedAt: "2026-09-02T00:00:01.000Z",
          tokensBefore: 100,
          readFiles: [],
          modifiedFiles: [],
        }),
      );
      sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "new work" }],
        timestamp: Date.now(),
      });
      sessionManager.appendCompaction(
        "secret newer summary",
        keptId,
        200,
        createCompactionDetails({
          jobId: "job-new",
          sessionId: sessionManager.getSessionId(),
          sessionHeaderId: sessionManager.getHeader().id,
          boundaryId: "boundary-new",
          preBoundaryLeafId: keptId,
          priorCompactionId: firstId,
          focusBinding: { entryId: bindingId, binding },
          trigger: "tool",
          model: "test:small",
          startedAt: "2026-09-02T00:00:02.000Z",
          completedAt: "2026-09-02T00:00:03.000Z",
          tokensBefore: 200,
          readFiles: [],
          modifiedFiles: [],
        }),
      );
    },
  });

  await fake.commands.get("focus-compact-history").handler("", fake.ctx);

  const history = fake.notifications.filter(({ message }) => message.includes("boundary="));
  assert.equal(history.length, 2);
  assert.match(history[0].message, /2026-09-02T00:00:03.000Z/);
  assert.match(history[0].message, /trigger=tool/);
  assert.match(history[0].message, /model=test:small/);
  assert.match(history[0].message, /tokens=200/);
  assert.match(history[0].message, /focus=focus-history/);
  assert.match(history[0].message, /subfocus=subfocus-history/);
  assert.match(history[0].message, /boundary=boundary-new/);
  assert.match(history[1].message, /boundary=boundary-old/);
  assert.equal(history.every(({ message }) => message.length <= 180), true);
  assert.equal(history.some(({ message }) => /raw secret|secret .* summary/.test(message)), false);
});

test("later generations inherit file operations and promote reads to modifications", async () => {
  const fake = await loadCompactExtension();
  fake.appendUser("first generation");
  appendAssistantToolCalls(fake.sessionManager, [
    { name: "read", path: "/later-edited" },
    { name: "read", path: "/read-only" },
  ]);
  fake.appendUser("first generation recent");

  await fake.commands.get("focus-compact").handler("", fake.ctx);
  await fake.flushCompactions();
  fake.auth.resolve({ ok: true, apiKey: "test-key", headers: {} });
  await tick();
  fake.completion.resolve(summaryResult("first summary"));
  await tick();
  await fake.flushCompactions();

  appendAssistantToolCalls(fake.sessionManager, [
    { name: "edit", path: "/later-edited" },
    { name: "read", path: "/second-read" },
  ]);
  fake.appendUser("second generation recent");
  await fake.commands.get("focus-compact").handler("", fake.ctx);
  await fake.flushCompactions();
  await tick();
  await fake.flushCompactions();

  const compactions = fake.sessionManager.getBranch().filter(
    (entry) => entry.type === "compaction",
  );
  assert.equal(compactions.length, 2);
  assert.deepEqual(compactions[0].details.readFiles, ["/later-edited", "/read-only"]);
  assert.deepEqual(compactions[1].details.readFiles, ["/read-only", "/second-read"]);
  assert.deepEqual(compactions[1].details.modifiedFiles, ["/later-edited"]);
});

test("missing model cancels the capture probe without default compaction", async () => {
  const fake = await loadCompactExtension({ model: null });
  fake.appendUser("old context");
  appendAssistant(fake.sessionManager, "recent context");
  const before = contextTexts(fake.sessionManager);

  await fake.commands.get("focus-compact").handler("", fake.ctx);
  await fake.flushCompactions();

  assert.deepEqual(contextTexts(fake.sessionManager), before);
  assert.deepEqual(fake.compactCalls[0].result, { cancel: true });
  assert.equal(boundaryEntries(fake.sessionManager).length, 0);
  assert.equal(
    fake.sessionManager.getBranch().some((entry) => entry.type === "compaction"),
    false,
  );
  assert.match(fake.notifications.at(-1).message, /no model available/i);
});

test("failed boundary append cancels the capture probe without default compaction", async () => {
  const fake = await loadCompactExtension();
  fake.appendUser("old context");
  appendAssistant(fake.sessionManager, "recent context");
  const before = contextTexts(fake.sessionManager);
  fake.pi.appendEntry = () => {};

  await fake.commands.get("focus-compact").handler("", fake.ctx);
  await fake.flushCompactions();

  assert.deepEqual(contextTexts(fake.sessionManager), before);
  assert.deepEqual(fake.compactCalls[0].result, { cancel: true });
  assert.equal(
    fake.sessionManager.getBranch().some((entry) => entry.type === "compaction"),
    false,
  );
  assert.match(fake.notifications.at(-1).message, /boundary capture failed/i);
});

for (const [failure, resolveFailure, warning] of [
  ["missing auth", async (fake) => {
    fake.auth.resolve({ ok: false, error: "missing auth" });
  }, /missing auth/i],
  ["provider rejection", async (fake) => {
    fake.auth.resolve({ ok: true, apiKey: "test-key", headers: {} });
    await tick();
    fake.completion.reject(new Error("provider rejected"));
  }, /provider rejected/i],
  ["empty summary", async (fake) => {
    fake.auth.resolve({ ok: true, apiKey: "test-key", headers: {} });
    await tick();
    fake.completion.resolve(summaryResult("   "));
  }, /summary was empty/i],
  ...["error", "length", "aborted"].map((stopReason) => [
    `${stopReason} stop reason`,
    async (fake) => {
      fake.auth.resolve({ ok: true, apiKey: "test-key", headers: {} });
      await tick();
      fake.completion.resolve(summaryResult("unused", stopReason));
    },
    new RegExp(`summary stopped: ${stopReason}`, "i"),
  ]),
]) {
  test(`${failure} leaves only an invisible boundary and re-arms`, async () => {
    const fake = await loadCompactExtension();
    fake.appendUser("old context");
    appendAssistant(fake.sessionManager, "recent context");
    const before = contextTexts(fake.sessionManager);
    await fake.commands.get("focus-compact").handler("", fake.ctx);
    await fake.flushCompactions();

    await resolveFailure(fake);
    await tick();

    assert.deepEqual(contextTexts(fake.sessionManager), before);
    assert.equal(boundaryEntries(fake.sessionManager).length, 1);
    assert.equal(
      fake.sessionManager.getBranch().some((entry) => entry.type === "compaction"),
      false,
    );
    assert.match(fake.notifications.at(-1).message, warning);
    const notificationCount = fake.notifications.length;
    await fake.commands.get("focus-compact").handler("", fake.ctx);
    assert.equal(
      fake.notifications.slice(notificationCount).some(({ message }) => /scheduled/i.test(message)),
      true,
    );
  });
}

test("native ready-commit preparation failure clears committing state", async () => {
  const fake = await loadCompactExtension();
  fake.appendUser("old context");
  appendAssistant(fake.sessionManager, "recent context");
  const before = contextTexts(fake.sessionManager);
  await fake.commands.get("focus-compact").handler("", fake.ctx);
  await fake.flushCompactions();
  fake.auth.resolve({ ok: true, apiKey: "test-key", headers: {} });
  await tick();
  fake.ctx.compact = ({ onError }) => onError(new Error("native auth unavailable"));

  fake.completion.resolve(summaryResult("ready summary"));
  await tick();

  assert.deepEqual(contextTexts(fake.sessionManager), before);
  assert.equal(
    fake.sessionManager.getBranch().some((entry) => entry.type === "compaction"),
    false,
  );
  assert.match(fake.notifications.at(-1).message, /native auth unavailable/i);
  const notificationCount = fake.notifications.length;
  await fake.commands.get("focus-compact").handler("", fake.ctx);
  assert.equal(
    fake.notifications.slice(notificationCount).some(({ message }) => /scheduled/i.test(message)),
    true,
  );
});

test("overflow falls through to Pi while a background job is not ready", async () => {
  const fake = await loadCompactExtension();
  fake.appendUser("old context");
  appendAssistant(fake.sessionManager, "recent context");
  await fake.commands.get("focus-compact").handler("", fake.ctx);
  await fake.flushCompactions();
  const probe = fake.compactCalls[0];

  const result = await fake.handlers.get("session_before_compact")({
    type: "session_before_compact",
    preparation: probe.preparation,
    branchEntries: fake.sessionManager.buildContextEntries(),
    reason: "overflow",
    willRetry: true,
    signal: new AbortController().signal,
  }, fake.ctx);

  assert.equal(result, undefined);
  assert.equal(boundaryEntries(fake.sessionManager).length, 1);
  assert.equal(fake.compactCalls.length, 1);
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
