import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFocus, updateFocus } from "../extensions/focus-core.mjs";
import { findFocusPath } from "../extensions/focus-core.mjs";
import { FOCUS_BINDING_CUSTOM_TYPE, createLocalFocusBinding, restoreFocusBinding } from "../extensions/focus-session.mjs";
import { loadFocusCatalog, updateFocusCatalog } from "../extensions/focus-store.mjs";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const extension = await jiti.import("../extensions/index.ts");

const NOW = "2026-09-02T00:00:00.000Z";

function createCatalog() {
  const cwd = mkdtempSync(join(tmpdir(), "focus-extension-"));
  const alpha = updateFocusCatalog(cwd, (catalog) => createFocus(catalog, {
    name: "Alpha",
    goals: "Alpha goal",
    activation: { tools: ["read"] },
  }, NOW));
  const beta = updateFocusCatalog(cwd, (catalog) => createFocus(catalog, {
    name: "Beta",
    goals: "Beta goal",
    activation: { tools: ["bash"] },
  }, NOW));
  return { cwd, alpha, beta };
}

function createHarness(cwd, sessionId, options = {}) {
  const events = new Map();
  const commands = new Map();
  const notices = [];
  const status = new Map();
  const uiChanges = [];
  let selectCalls = 0;
  let setActiveToolsCalls = 0;
  let throwAfterAppend = false;
  const sessionManager = {
    sessionId,
    branch: options.branch ?? [],
    getSessionId() { return this.sessionId; },
    getBranch() { return [...this.branch]; },
    getLeafId() { return this.branch.at(-1)?.id ?? null; },
  };
  const pi = {
    on(name, handler) { events.set(name, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    appendEntry(customType, data) {
      sessionManager.branch.push({
        type: "custom",
        id: `entry-${sessionManager.branch.length + 1}`,
        parentId: sessionManager.getLeafId(),
        customType,
        data,
      });
      if (throwAfterAppend) throw new Error("persistence failed after leaf advance");
    },
    getActiveTools() { return ["read", "bash", "write"]; },
    getAllTools() { return ["read", "bash", "write"].map((name) => ({ name })); },
    setActiveTools() { setActiveToolsCalls += 1; throw new Error("focus must only guard tools"); },
  };
  const ctx = {
    cwd,
    hasUI: options.hasUI ?? false,
    sessionManager,
    isIdle() { return true; },
    async waitForIdle() {},
    ui: {
      async select(title, choices) {
        selectCalls += 1;
        return options.select?.(title, choices) ?? undefined;
      },
      async input(title, placeholder) { return options.input?.(title, placeholder); },
      async editor(title, initial) { return options.editor?.(title, initial); },
      notify(message, level) { notices.push({ message, level }); },
      setStatus(key, value) { uiChanges.push({ key, value }); status.set(key, value); },
      setTitle(value) { uiChanges.push({ key: "title", value }); },
      theme: { fg(_color, text) { return text; } },
    },
    parentPrompt: "Parent is focused on Alpha",
    environment: { PI_FOCUS_BINDING: "parent-owned-alpha" },
  };
  extension.default(pi);
  return {
    commands,
    ctx,
    events,
    notices,
    pi,
    uiChanges,
    sessionManager,
    get selectCalls() { return selectCalls; },
    get setActiveToolsCalls() { return setActiveToolsCalls; },
    set throwAfterAppend(value) { throwAfterAppend = value; },
  };
}

async function start(harness, reason = "startup") {
  await harness.events.get("session_start")({ reason }, harness.ctx);
}

async function use(harness, id) {
  await harness.commands.get("focus").handler(`use ${id}`, harness.ctx);
}

function contextText(harness) {
  const result = harness.events.get("context")({ messages: [] }, harness.ctx);
  return result.messages.at(-1)?.content?.[0]?.text ?? "";
}

test("extension instances keep context and guards session-local without changing tools", async (t) => {
  const { cwd } = createCatalog();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const a = createHarness(cwd, "session-a");
  const b = createHarness(cwd, "session-b");

  await start(a);
  await start(b);
  await use(a, "alpha");
  await use(b, "beta");

  assert.match(contextText(a), /Focus: Alpha/);
  assert.match(contextText(b), /Focus: Beta/);
  assert.match(a.events.get("tool_call")({ toolName: "bash" }, a.ctx).reason, /not declared/);
  assert.equal(a.events.get("tool_call")({ toolName: "read" }, a.ctx), undefined);
  assert.match(b.events.get("tool_call")({ toolName: "read" }, b.ctx).reason, /not declared/);
  assert.equal(b.events.get("tool_call")({ toolName: "bash" }, b.ctx), undefined);

  await use(a, "beta");
  assert.match(contextText(a), /Focus: Beta/);
  assert.match(contextText(b), /Focus: Beta/);
  assert.equal(a.setActiveToolsCalls, 0);
  assert.equal(b.setActiveToolsCalls, 0);
});

test("reload, fresh starts, fork/clone, tree, and shutdown follow the standalone lifecycle", async (t) => {
  const { cwd } = createCatalog();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const catalog = loadFocusCatalog(cwd);
  const alpha = findFocusPath(catalog, "alpha");
  const saved = createLocalFocusBinding({
    agentSessionId: "saved-session",
    capturedAt: NOW,
    active: alpha,
    last: alpha,
  });

  const reload = createHarness(cwd, "saved-session", { branch: [{
    id: "saved-entry", type: "custom", customType: FOCUS_BINDING_CUSTOM_TYPE, data: saved,
  }] });
  await start(reload, "reload");
  assert.match(contextText(reload), /Focus: Alpha/);

  for (const reason of ["startup", "new", "resume"]) {
    const fresh = createHarness(cwd, `${reason}-session`, { branch: [{
      id: "historical", type: "custom", customType: FOCUS_BINDING_CUSTOM_TYPE, data: saved,
    }] });
    await start(fresh, reason);
    const restored = restoreFocusBinding(fresh.sessionManager.getBranch());
    assert.equal(restored.binding.active, null, `${reason} must append off`);
    assert.equal(contextText(fresh), "");
  }

  for (const action of ["fork", "clone"]) {
    const child = createHarness(cwd, `${action}-session`, { branch: [{
      id: "source-entry", type: "custom", customType: FOCUS_BINDING_CUSTOM_TYPE, data: saved,
    }] });
    await start(child, "fork");
    const forked = restoreFocusBinding(child.sessionManager.getBranch()).binding;
    assert.equal(forked.source, "fork", `${action} uses the shared fork lifecycle reason`);
    assert.deepEqual(forked.forkedFrom, { sessionId: "saved-session", entryId: "source-entry" });
  }
  const child = createHarness(cwd, "child-session", { branch: [{
    id: "source-entry", type: "custom", customType: FOCUS_BINDING_CUSTOM_TYPE, data: saved,
  }] });
  await start(child, "fork");
  child.sessionManager.branch.push({ id: "tree-leaf", type: "message" });
  const beforeTree = restoreFocusBinding(child.sessionManager.getBranch()).binding;
  await child.events.get("session_tree")({}, child.ctx);
  const treeEntry = child.sessionManager.branch.at(-1);
  assert.equal(treeEntry.parentId, "tree-leaf");
  assert.deepEqual(treeEntry.data, beforeTree);

  const uiChangesBeforeShutdown = child.uiChanges.length;
  await child.events.get("session_shutdown")({}, child.ctx);
  assert.equal(contextText(child), "");
  assert.equal(child.uiChanges.length, uiChangesBeforeShutdown, "shutdown must not mutate UI state or title");

  const nonInteractiveChild = createHarness(cwd, "fresh-child");
  await start(nonInteractiveChild);
  assert.equal(restoreFocusBinding(nonInteractiveChild.sessionManager.getBranch()).binding.active, null);
  assert.equal(nonInteractiveChild.selectCalls, 0);
});

test("catalog mutations rebind only their own session and deletion leaves peer snapshots intact", async (t) => {
  const { cwd } = createCatalog();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const deleteChoices = ["Alpha (alpha)", "Delete “Alpha”"];
  const a = createHarness(cwd, "session-a", {
    hasUI: true,
    editor(title) { return title === "Add focus data" ? "A-only update" : undefined; },
    select(title, choices) {
      return title === "Focus" ? undefined : deleteChoices.shift() ?? choices[0];
    },
  });
  const b = createHarness(cwd, "session-b");
  await start(a);
  await start(b);
  await use(a, "alpha");
  await use(b, "alpha");

  await a.commands.get("focus").handler("expand", a.ctx);
  assert.equal(loadFocusCatalog(cwd).foci.find((focus) => focus.id === "alpha").revision, 2);
  assert.match(contextText(a), /Focus captured revision: 2/);
  assert.match(contextText(b), /Focus captured revision: 1/);

  await a.commands.get("focus").handler("delete", a.ctx);
  assert.equal(loadFocusCatalog(cwd).foci.some((focus) => focus.id === "alpha"), false);
  assert.equal(contextText(a), "");
  assert.match(contextText(b), /Focus: Alpha/);
  assert.match(contextText(b), /Focus captured revision: 1/);
});

test("commands use captured last, reconcile append outcomes, and complete catalog IDs", async (t) => {
  const { cwd } = createCatalog();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const h = createHarness(cwd, "session-a");
  await start(h);
  await use(h, "alpha");
  await h.commands.get("focus").handler("off", h.ctx);
  updateFocusCatalog(cwd, (catalog) => {
    const alpha = catalog.foci.find((focus) => focus.id === "alpha");
    return updateFocus(catalog, "alpha", { createdAt: alpha.createdAt, revision: alpha.revision }, { goals: "new disk value" }, NOW);
  });
  await h.commands.get("focus").handler("on", h.ctx);
  assert.match(contextText(h), /Alpha goal/);
  assert.doesNotMatch(contextText(h), /new disk value/);

  const command = h.commands.get("focus");
  assert.deepEqual(command.getArgumentCompletions("").map((item) => item.value).slice(0, 3), ["new", "edit", "delete"]);
  assert.deepEqual(command.getArgumentCompletions("use ").map((item) => item.value), ["use alpha", "use beta"]);

  h.throwAfterAppend = true;
  await use(h, "beta");
  assert.match(contextText(h), /Focus: Beta/);
  assert.match(h.notices.at(-1).message, /persistence failed/i);
  assert.equal(restoreFocusBinding(h.sessionManager.getBranch()).binding.active.focus.id, "beta");
  assert.equal(h.setActiveToolsCalls, 0);
});
