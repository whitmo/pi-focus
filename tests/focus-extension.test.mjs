import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFocus, createSubfocus, retireFocus, updateFocus } from "../extensions/focus-core.mjs";
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
  const alphaChild = updateFocusCatalog(cwd, (catalog) => createSubfocus(catalog, alpha.focus.id, {
    name: "Alpha child",
    goals: "Alpha child goal",
  }, NOW));
  const beta = updateFocusCatalog(cwd, (catalog) => createFocus(catalog, {
    name: "Beta",
    goals: "Beta goal",
    activation: { tools: ["bash"] },
  }, NOW));
  return { cwd, alpha, alphaChild, beta };
}

function createHarness(cwd, sessionId, options = {}) {
  const events = new Map();
  const bus = new Map();
  const commands = new Map();
  const notices = [];
  const userMessages = [];
  const status = new Map();
  const uiChanges = [];
  let selectCalls = 0;
  let setActiveToolsCalls = 0;
  let waitForIdleCalls = 0;
  let idle = options.isIdle ?? true;
  let activeTools = [...(options.activeTools ?? ["read", "bash", "write"])];
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
    events: { on(name, handler) { bus.set(name, handler); return () => bus.delete(name); } },
    registerCommand(name, command) { commands.set(name, command); },
    sendUserMessage(message, options) { userMessages.push({ message, options }); },
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
    getActiveTools() { return [...activeTools]; },
    getAllTools() { return ["read", "bash", "write"].map((name) => ({ name })); },
    getCommands() {
      return (options.commands ?? []).map((name) => ({ name, source: "extension" }));
    },
    setActiveTools() { setActiveToolsCalls += 1; throw new Error("focus must only guard tools"); },
  };
  const ctx = {
    cwd,
    hasUI: options.hasUI ?? false,
    sessionManager,
    isIdle() { return idle; },
    async waitForIdle() {
      waitForIdleCalls += 1;
      await options.waitForIdle?.();
      idle = true;
    },
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
    bus,
    commands,
    ctx,
    events,
    notices,
    pi,
    status,
    uiChanges,
    sessionManager,
    userMessages,
    get selectCalls() { return selectCalls; },
    get setActiveToolsCalls() { return setActiveToolsCalls; },
    get waitForIdleCalls() { return waitForIdleCalls; },
    set activeTools(value) { activeTools = [...value]; },
    set throwAfterAppend(value) { throwAfterAppend = value; },
  };
}

async function start(harness, reason = "startup") {
  await harness.events.get("session_start")({ reason }, harness.ctx);
}

async function use(harness, id) {
  await harness.commands.get("focus").handler(`use ${id}`, harness.ctx);
}

function bindChild(harness, focus) {
  let acknowledgement;
  harness.bus.get("pi-focus:bind-child")?.({
    ...focus,
    acknowledge(result) { acknowledgement = result; },
  });
  return acknowledgement;
}

function contextText(harness) {
  const beforeAgentStart = harness.events.get("before_agent_start");
  if (beforeAgentStart) {
    return beforeAgentStart({ systemPrompt: "", prompt: "", images: [] }, harness.ctx)?.systemPrompt ?? "";
  }
  const result = harness.events.get("context")({ messages: [] }, harness.ctx);
  return result.messages.at(-1)?.content?.[0]?.text ?? "";
}

test("child startup binds a catalog focus/subfocus locally before context and guards", async (t) => {
  const { cwd, alpha, alphaChild } = createCatalog();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const parent = createHarness(cwd, "parent");
  const a = createHarness(cwd, "child-a");
  const b = createHarness(cwd, "child-b");
  await Promise.all([start(parent), start(a), start(b)]);
  await use(parent, "beta");
  const parentBefore = structuredClone(parent.sessionManager.getBranch());

  assert.deepEqual(bindChild(a, { focusId: alpha.focus.id, subfocusId: alphaChild.subfocus.id }), { ok: true });
  assert.deepEqual(bindChild(b, { focusId: "beta" }), { ok: true });
  assert.deepEqual(parent.sessionManager.getBranch(), parentBefore);

  const stored = restoreFocusBinding(a.sessionManager.getBranch()).binding;
  assert.equal(stored.agentSessionId, "child-a");
  assert.equal(stored.active.focus.id, "alpha");
  assert.equal(stored.active.subfocus.id, "alpha-child");
  assert.equal(Object.isFrozen(stored.active.focus), true);
  assert.match(contextText(a), /Focus: Alpha/);
  assert.match(contextText(a), /Subfocus: Alpha child/);
  assert.match(a.events.get("tool_call")({ toolName: "bash" }, a.ctx).reason, /not declared/);
  assert.equal(a.events.get("tool_call")({ toolName: "read" }, a.ctx), undefined);
  assert.match(contextText(b), /Focus: Beta/);
  assert.equal(a.setActiveToolsCalls, 0);
  assert.equal(b.setActiveToolsCalls, 0);

  updateFocusCatalog(cwd, (catalog) => updateFocus(
    catalog,
    "alpha",
    { createdAt: alpha.focus.createdAt, revision: alpha.focus.revision },
    { goals: "changed after capture" },
    NOW,
  ));
  assert.match(contextText(a), /Alpha goal/);
  assert.doesNotMatch(contextText(a), /changed after capture/);
});

test("child startup acknowledges malformed, missing, retired, conflicting, and persistence failures", async (t) => {
  const { cwd, alpha } = createCatalog();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const h = createHarness(cwd, "child");
  await start(h);
  const initialEntries = h.sessionManager.getBranch().length;

  for (const selector of [
    {},
    { focusId: "INVALID!" },
    { focusId: "missing" },
    { focusId: "alpha", subfocusId: "missing" },
  ]) {
    const acknowledgement = bindChild(h, selector);
    assert.equal(acknowledgement.ok, false);
    assert.match(acknowledgement.error, /focus/i);
    assert.equal(h.sessionManager.getBranch().length, initialEntries);
  }

  updateFocusCatalog(cwd, (catalog) => retireFocus(
    catalog,
    alpha.focus.id,
    { createdAt: alpha.focus.createdAt, revision: alpha.focus.revision },
  ));
  const retired = bindChild(h, { focusId: "alpha" });
  assert.equal(retired.ok, false);
  assert.match(retired.error, /focus/i);

  h.throwAfterAppend = true;
  const persistence = bindChild(h, { focusId: "beta" });
  assert.equal(persistence.ok, false);
  assert.match(persistence.error, /persistence/i);
});

test("cold resume restores its snapshot and rejects a conflicting startup selector", async (t) => {
  const { cwd } = createCatalog();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const original = createLocalFocusBinding({
    agentSessionId: "saved-session",
    capturedAt: NOW,
    active: findFocusPath(loadFocusCatalog(cwd), "alpha"),
    last: findFocusPath(loadFocusCatalog(cwd), "alpha"),
  });
  const h = createHarness(cwd, "saved-session", { branch: [{
    id: "saved-entry",
    type: "custom",
    customType: FOCUS_BINDING_CUSTOM_TYPE,
    data: original,
  }] });

  await start(h, "resume");
  assert.match(contextText(h), /Focus: Alpha/);
  assert.equal(h.sessionManager.getBranch().length, 1);
  assert.deepEqual(bindChild(h, { resume: true }), { ok: true });
  assert.equal(h.sessionManager.getBranch().length, 1);
  assert.deepEqual(bindChild(h, { focusId: "alpha" }), { ok: true });
  assert.equal(h.sessionManager.getBranch().length, 1);
  const conflict = bindChild(h, { focusId: "beta" });
  assert.equal(conflict.ok, false);
  assert.match(conflict.error, /conflict/i);
  assert.match(contextText(h), /Focus: Alpha/);
});

test("an active focus follows pi-loadout host selections without inventing a focus guard", async (t) => {
  const { cwd } = createCatalog();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const unguarded = updateFocusCatalog(cwd, (catalog) => createFocus(catalog, {
    name: "Unguarded",
    goals: "Let the session loadout remain authoritative",
  }, NOW));
  const h = createHarness(cwd, "session-loadout", { commands: ["loadout"] });

  await start(h);
  await use(h, unguarded.focus.id);
  assert.match(contextText(h), /Loadout integration: \/loadout available \(live host selection\)/);
  assert.match(contextText(h), /Focus guard: none; current host loadout remains authoritative/);
  assert.equal(h.status.get("focus-capabilities"), undefined);

  h.activeTools = ["read"];
  assert.match(contextText(h), /Host loadout: 1\/3 registered tools active/);
  assert.equal(h.events.get("tool_call")({ toolName: "read" }, h.ctx), undefined);
  assert.equal(h.setActiveToolsCalls, 0);
});

test("a declared focus guard tracks live pi-loadout tool changes", async (t) => {
  const { cwd } = createCatalog();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const h = createHarness(cwd, "session-guarded-loadout", { commands: ["loadout"] });

  await start(h);
  await use(h, "alpha");
  h.activeTools = ["bash"];
  assert.match(contextText(h), /Loadout integration: \/loadout available \(live host selection\)/);
  assert.match(contextText(h), /Focus guard: declared tools are intersected with the current host loadout/);
  assert.match(h.events.get("tool_call")({ toolName: "read" }, h.ctx).reason, /declared but not active/);

  h.activeTools = ["read"];
  assert.equal(h.events.get("tool_call")({ toolName: "read" }, h.ctx), undefined);
  assert.equal(h.setActiveToolsCalls, 0);
});

test("an active focus remains usable when pi-loadout is not registered", async (t) => {
  const { cwd } = createCatalog();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const unguarded = updateFocusCatalog(cwd, (catalog) => createFocus(catalog, {
    name: "Standalone",
  }, NOW));
  const h = createHarness(cwd, "session-standalone");

  await start(h);
  await use(h, unguarded.focus.id);
  assert.match(contextText(h), /Loadout integration: pi-loadout unavailable \(optional\)/);
  assert.match(contextText(h), /Focus guard: none; current host loadout remains authoritative/);
  assert.equal(h.events.get("tool_call")({ toolName: "read" }, h.ctx), undefined);
  assert.equal(h.setActiveToolsCalls, 0);
});

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

  for (const reason of ["startup", "new"]) {
    const fresh = createHarness(cwd, `${reason}-session`, { branch: [{
      id: "historical", type: "custom", customType: FOCUS_BINDING_CUSTOM_TYPE, data: saved,
    }] });
    await start(fresh, reason);
    const restored = restoreFocusBinding(fresh.sessionManager.getBranch());
    assert.equal(restored.binding.active, null, `${reason} must append off`);
    assert.equal(contextText(fresh), "");
  }

  const resume = createHarness(cwd, "resume-session", { branch: [{
    id: "historical", type: "custom", customType: FOCUS_BINDING_CUSTOM_TYPE, data: saved,
  }] });
  await start(resume, "resume");
  assert.equal(restoreFocusBinding(resume.sessionManager.getBranch()).binding.active.focus.id, "alpha");
  assert.equal(resume.sessionManager.getBranch().length, 1);
  assert.match(contextText(resume), /Focus: Alpha/);

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

test("focus context stays hidden in the system prompt instead of adding transcript messages", async (t) => {
  const { cwd } = createCatalog();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const h = createHarness(cwd, "session-hidden-context");

  await start(h);
  await use(h, "alpha");

  assert.equal(h.events.has("context"), false);
  assert.match(contextText(h), /Focus: Alpha/);
});

test("argument-bearing focus skill input preserves the original event and forwards only the task", async (t) => {
  const { cwd } = createCatalog();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const h = createHarness(cwd, "session-focus-input", { isIdle: false });
  const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
  await start(h);

  const first = await h.events.get("input")({
    text: "/skill:focus focus on Beta and review its pull requests",
    images: [image],
    source: "interactive",
    streamingBehavior: "steer",
  }, h.ctx);
  assert.deepEqual(first, { action: "transform", text: "review its pull requests", images: [image] });
  assert.equal(h.waitForIdleCalls, 1);
  assert.match(contextText(h), /Focus: Beta/);
  assert.equal(h.userMessages.length, 0);
  assert.deepEqual(h.notices, [{ message: "focus: Beta", level: "info" }]);

  const repeated = await h.events.get("input")({
    text: "/skill:focus focus on Beta and review its pull requests",
    source: "interactive",
  }, h.ctx);
  assert.deepEqual(repeated, { action: "transform", text: "review its pull requests", images: undefined });
  assert.equal(h.notices.length, 1, "already-active focus must not announce again");
  assert.equal(h.userMessages.length, 0);
});

test("argument-bearing focus skill input can create through the existing chooser", async (t) => {
  const { cwd } = createCatalog();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const h = createHarness(cwd, "session-focus-create", {
    hasUI: true,
    select(_title, choices) { return choices.find((choice) => choice.startsWith("Create new focus")); },
    editor(title) { return title === "Goals" ? "Ship the new initiative" : ""; },
  });
  await start(h);

  const result = await h.events.get("input")({
    text: "/skill:focus focus on New Initiative",
    source: "interactive",
  }, h.ctx);
  assert.deepEqual(result, { action: "handled" });
  assert.equal(loadFocusCatalog(cwd).foci.some((focus) => focus.name === "New Initiative"), true);
  assert.match(contextText(h), /Ship the new initiative/);
  assert.equal(h.userMessages.length, 0);
  assert.deepEqual(h.notices.at(-1), { message: "focus: New Initiative", level: "info" });
});

test("focus selectors use token boundaries and allow short exact names", async (t) => {
  const { cwd } = createCatalog();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  updateFocusCatalog(cwd, (catalog) => createFocus(catalog, { name: "API", goals: "API work" }, NOW));
  updateFocusCatalog(cwd, (catalog) => createFocus(catalog, { name: "QA", goals: "QA work" }, NOW));
  const h = createHarness(cwd, "session-focus-boundaries");
  await start(h);
  await use(h, "alpha");

  const falseMatch = await h.events.get("input")({
    text: "/skill:focus focus on capitalize the heading",
    source: "interactive",
  }, h.ctx);
  assert.deepEqual(falseMatch, { action: "handled" });
  assert.match(contextText(h), /Focus: Alpha/);

  const shortName = await h.events.get("input")({
    text: "/skill:focus focus on QA and inspect tests",
    source: "interactive",
  }, h.ctx);
  assert.deepEqual(shortName, { action: "transform", text: "inspect tests", images: undefined });
  assert.match(contextText(h), /Focus: QA/);
});

test("mutating focus commands wait for an active run to settle", async (t) => {
  const { cwd } = createCatalog();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const h = createHarness(cwd, "session-focus-command-wait", { isIdle: false });
  await start(h);

  await h.commands.get("focus").handler("use beta", h.ctx);
  assert.equal(h.waitForIdleCalls, 1);
  assert.match(contextText(h), /Focus: Beta/);
});

test("bare focus skill invocation still expands normally and extension-injected tasks do not recurse", async (t) => {
  const { cwd } = createCatalog();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const h = createHarness(cwd, "session-focus-pass-through");
  await start(h);

  assert.deepEqual(await h.events.get("input")({ text: "/skill:focus", source: "interactive" }, h.ctx), { action: "continue" });
  assert.deepEqual(await h.events.get("input")({ text: "/skill:focus focus on Beta", source: "extension" }, h.ctx), { action: "continue" });
});

test("focus skill documents one-time acknowledgements and hidden recurring context", () => {
  const skill = readFileSync(new URL("../skills/focus/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /arguments/i);
  assert.match(skill, /acknowledge.*once/i);
  assert.match(skill, /must not be repeated/i);
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
