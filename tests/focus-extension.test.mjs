import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { moduleCache: false });

test("registers focus command, skill resources, status, and context injection", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "focus-extension-"));
  mkdirSync(join(cwd, ".agents", "focus"), { recursive: true });
  writeFileSync(join(cwd, ".agents", "focus", "state.json"), JSON.stringify({
    activeFocusId: "ship-feature",
    lastFocusId: "ship-feature",
    updatedAt: "2026-08-05T12:00:00.000Z",
    foci: [{
      id: "ship-feature",
      name: "Ship feature",
      goals: "Finish implementation",
      scope: "Web app",
      constraints: "Small diff",
      planningDocs: ["plan.md"],
      refs: ["Issue #1"],
      notes: [],
      subfocuses: [],
      activeSubfocusId: null,
      createdAt: "2026-08-05T12:00:00.000Z",
      updatedAt: "2026-08-05T12:00:00.000Z",
    }],
  }));

  mkdirSync(join(cwd, ".agents", "focus", "foci", "ship-feature", "kb"), { recursive: true });
  writeFileSync(join(cwd, ".agents", "focus", "foci", "ship-feature", "kb", "sentinel.md"), "KB-SENTINEL-SECRET");

  const events = new Map();
  const commands = new Map();
  const activeTools = ["read", "write", "bash", "loadout_profile"];
  const pi = {
    on(name, handler) { events.set(name, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    getActiveTools() { return [...activeTools]; },
    getAllTools() { return activeTools.map((name) => ({ name })); },
    setActiveTools(next) { activeTools.splice(0, activeTools.length, ...next); },
  };

  const mod = await jiti.import("../extensions/index.ts");
  mod.default(pi);

  assert.ok(commands.has("focus"));
  assert.deepEqual(Object.keys(events.get("resources_discover")()), ["skillPaths"]);
  assert.match(events.get("resources_discover")().skillPaths[0], /skills$/);

  let status;
  const ctx = {
    cwd,
    ui: {
      setStatus(key, value) { if (key === "focus") status = value; },
      setTitle() {},
      theme: { fg(_color, text) { return `bright:${text}`; } },
    },
  };

  events.get("session_start")({}, ctx);
  assert.equal(status, "bright:focus:Ship feature");

  const originalMessages = [{ role: "user", content: [{ type: "text", text: "keep me" }] }];
  const first = events.get("context")({ messages: originalMessages }, { cwd });
  const second = events.get("context")({ messages: originalMessages }, { cwd });
  assert.deepEqual(originalMessages, [{ role: "user", content: [{ type: "text", text: "keep me" }] }]);
  assert.equal(first.messages.length, 2);
  assert.equal(second.messages.length, 2);
  assert.equal(first.messages[0], originalMessages[0]);
  assert.deepEqual(Object.keys(first.messages[1]).sort(), ["content", "customType", "display", "role", "timestamp"]);
  assert.equal(first.messages[1].role, "custom");
  assert.equal(first.messages[1].customType, "focus-context");
  assert.equal(first.messages[1].display, false);
  assert.equal(typeof first.messages[1].timestamp, "number");
  assert.match(first.messages[1].content[0].text, /Project-provided goals: Finish implementation/);
  assert.match(first.messages[1].content[0].text, /foci\/ship-feature\/state/);
  assert.equal(first.messages[1].content[0].text.includes("KB-SENTINEL-SECRET"), false);
});

test("context reads the current disk state for each provider request without persisting or steering", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "focus-extension-context-"));
  mkdirSync(join(cwd, ".agents", "focus"), { recursive: true });
  const statePath = join(cwd, ".agents", "focus", "state.json");
  writeFileSync(statePath, JSON.stringify({
    activeFocusId: "first", lastFocusId: "first", updatedAt: null,
    foci: [{ id: "first", name: "First", goals: "Initial", activation: { tools: ["read"] } }],
  }));
  const events = new Map();
  let sent = 0;
  let entries = 0;
  const pi = {
    on(name, handler) { events.set(name, handler); },
    registerCommand() {},
    sendUserMessage() { sent += 1; },
    appendEntry() { entries += 1; },
    getActiveTools() { return ["read", "write"]; },
    getAllTools() { return [{ name: "read" }, { name: "write" }]; },
    setActiveTools() {},
  };
  const mod = await jiti.import("../extensions/index.ts");
  mod.default(pi);

  const first = events.get("context")({ messages: [] }, { cwd });
  assert.match(first.messages[0].content[0].text, /Initial/);
  writeFileSync(statePath, JSON.stringify({
    activeFocusId: "second", lastFocusId: "second", updatedAt: null,
    foci: [{ id: "second", name: "Second", goals: "Changed", activation: { tools: ["write"] } }],
  }));
  const second = events.get("context")({ messages: [] }, { cwd });
  assert.match(second.messages[0].content[0].text, /Changed/);
  assert.equal(sent, 0);
  assert.equal(entries, 0);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).sessionTools, undefined);
});

test("focus owns only its baseline tool restriction across loadouts, tree changes, and off", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "focus-extension-tools-"));
  mkdirSync(join(cwd, ".agents", "focus"), { recursive: true });
  const statePath = join(cwd, ".agents", "focus", "state.json");
  writeFileSync(statePath, JSON.stringify({
    activeFocusId: "one", lastFocusId: "one", updatedAt: null,
    foci: [
      { id: "one", name: "One", activation: { tools: ["read", "loadout_profile", "unknown"], loadout: "never-run", process: "never-run", subagent: "never-run" } },
      { id: "two", name: "Two", activation: { tools: ["write"] } },
    ],
  }));
  const events = new Map();
  const commands = new Map();
  const tools = ["read", "write", "bash", "loadout_profile"];
  const original = [...tools];
  let activeToolReads = 0;
  const pi = {
    on(name, handler) { events.set(name, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    getActiveTools() { activeToolReads += 1; return [...tools]; },
    getAllTools() { return original.map((name) => ({ name })); },
    setActiveTools(next) { tools.splice(0, tools.length, ...next); },
    sendUserMessage() { throw new Error("tool policy must not steer"); },
    exec() { throw new Error("tool policy must not execute commands"); },
    registerTool() { throw new Error("tool policy must not register resources"); },
  };
  const mod = await jiti.import("../extensions/index.ts");
  mod.default(pi);
  const statuses = new Map();
  let waited = false;
  const ctx = {
    cwd,
    async waitForIdle() { waited = true; },
    ui: {
      notify() {}, setStatus(key, value) { statuses.set(key, value); }, setTitle() {},
      theme: { fg(_color, text) { return text; } },
    },
  };

  events.get("session_start")({}, ctx);
  assert.deepEqual(tools, ["read", "loadout_profile"]);
  assert.match(statuses.get("focus-capabilities"), /process, subagent unavailable/);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(statePath, "utf8"))).sort(), ["activeFocusId", "foci", "lastFocusId", "updatedAt"]);
  assert.equal(events.get("tool_call")({ toolName: "bash" }, ctx).block, true);
  assert.equal(events.get("tool_call")({ toolName: "read" }, ctx), undefined);

  tools.splice(0, tools.length, ...original);
  events.get("tool_result")({ toolName: "loadout_profile" }, ctx);
  assert.deepEqual(tools, ["read", "loadout_profile"]);
  tools.splice(0, tools.length, ...original);
  events.get("before_agent_start")({ systemPrompt: "base" }, ctx);
  assert.deepEqual(tools, ["read", "loadout_profile"]);

  await commands.get("focus").handler("use two", ctx);
  assert.equal(waited, true);
  assert.ok(activeToolReads >= 1);
  assert.deepEqual(tools, ["write"]);

  events.get("session_before_tree")({}, ctx);
  assert.deepEqual(tools, original);
  events.get("session_tree")({}, ctx);
  assert.deepEqual(tools, ["write"]);
  events.get("session_shutdown")({ reason: "reload" }, ctx);
  assert.deepEqual(tools, original);
  events.get("session_start")({ reason: "reload" }, ctx);
  assert.deepEqual(tools, ["write"]);
  events.get("session_shutdown")({ reason: "quit" }, ctx);
  assert.deepEqual(tools, original);
  await commands.get("focus").handler("off", ctx);
  assert.deepEqual(tools, original);
});

test("an absent declaration preserves tools while an explicit empty declaration removes them", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "focus-extension-declarations-"));
  mkdirSync(join(cwd, ".agents", "focus"), { recursive: true });
  const events = new Map();
  const tools = ["read", "write"];
  const pi = {
    on(name, handler) { events.set(name, handler); },
    registerCommand() {},
    getActiveTools() { return [...tools]; },
    getAllTools() { return [{ name: "read" }, { name: "write" }]; },
    setActiveTools(next) { tools.splice(0, tools.length, ...next); },
  };
  const mod = await jiti.import("../extensions/index.ts");
  mod.default(pi);
  const ctx = { cwd, ui: { notify() {}, setStatus() {}, setTitle() {}, theme: { fg(_color, text) { return text; } } } };

  writeFileSync(join(cwd, ".agents", "focus", "state.json"), JSON.stringify({ activeFocusId: "none", lastFocusId: "none", updatedAt: null, foci: [{ id: "none", name: "None" }] }));
  events.get("session_start")({}, ctx);
  assert.deepEqual(tools, ["read", "write"]);
  events.get("session_shutdown")({}, ctx);
  writeFileSync(join(cwd, ".agents", "focus", "state.json"), JSON.stringify({ activeFocusId: "empty", lastFocusId: "empty", updatedAt: null, foci: [{ id: "empty", name: "Empty", activation: { tools: [] } }] }));
  events.get("session_start")({}, ctx);
  assert.deepEqual(tools, []);
});

test("/focus with no args opens a chooser and view reuses status behavior", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "focus-extension-chooser-"));
  mkdirSync(join(cwd, ".agents", "focus"), { recursive: true });
  writeFileSync(join(cwd, ".agents", "focus", "state.json"), JSON.stringify({
    activeFocusId: "ship-feature",
    lastFocusId: "ship-feature",
    updatedAt: null,
    foci: [{ id: "ship-feature", name: "Ship feature", goals: "Finish implementation", notes: [] }],
  }));

  const events = new Map();
  const commands = new Map();
  const pi = {
    on(name, handler) { events.set(name, handler); },
    registerCommand(name, command) { commands.set(name, command); },
  };
  const mod = await jiti.import("../extensions/index.ts");
  mod.default(pi);
  const choices = [];
  const notices = [];
  const ctx = {
    cwd,
    isIdle() { return true; },
    ui: {
      async select(title, options) { choices.push({ title, options }); return options[0]; },
      input: async () => undefined,
      editor: async () => undefined,
      notify(message) { notices.push(message); },
      setStatus() {},
      setTitle() {},
      theme: { fg(_color, text) { return text; } },
    },
  };

  await commands.get("focus").handler("", ctx);

  assert.equal(choices.length, 1);
  assert.equal(choices[0].options.length, 3);
  assert.match(choices[0].options[0], /view.*current focus/i);
  assert.match(notices[0], /Focus: Ship feature/);
});

test("/focus switch chooses a non-active focus and sends the return message", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "focus-extension-switch-"));
  mkdirSync(join(cwd, ".agents", "focus"), { recursive: true });
  writeFileSync(join(cwd, ".agents", "focus", "state.json"), JSON.stringify({
    activeFocusId: "current", lastFocusId: "current", updatedAt: null,
    foci: [{ id: "current", name: "Current" }, { id: "past", name: "Past focus" }],
  }));
  const commands = new Map();
  const selections = [];
  let status;
  let message;
  const pi = {
    on() {},
    registerCommand(name, command) { commands.set(name, command); },
    sendUserMessage(value) { message = value; },
  };
  const mod = await jiti.import("../extensions/index.ts");
  mod.default(pi);
  const ctx = {
    cwd,
    isIdle() { return true; },
    ui: {
      async select(_title, options) { selections.push(options); return options[selections.length - 1 === 0 ? 1 : 0]; },
      input: async () => undefined,
      editor: async () => undefined,
      notify() {},
      setStatus(key, value) { if (key === "focus") status = value; },
      setTitle() {},
      theme: { fg(_color, text) { return text; } },
    },
  };
  await commands.get("focus").handler("", ctx);
  assert.equal(selections.length, 2);
  assert.match(selections[1][0], /Past focus/);
  assert.equal(JSON.parse(readFileSync(join(cwd, ".agents", "focus", "state.json"), "utf8")).activeFocusId, "past");
  assert.equal(status, "focus:Past focus");
  assert.match(message, /Return to this focus/);
});

test("query create uses the query as the focus name without retyping", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "focus-extension-create-"));
  mkdirSync(join(cwd, ".agents", "focus"), { recursive: true });
  writeFileSync(join(cwd, ".agents", "focus", "state.json"), JSON.stringify({
    activeFocusId: null, lastFocusId: null, updatedAt: null, foci: [],
  }));
  const commands = new Map();
  const pi = {
    on() {},
    registerCommand(name, command) { commands.set(name, command); },
  };
  const mod = await jiti.import("../extensions/index.ts");
  mod.default(pi);
  const ctx = {
    cwd,
    isIdle() { return true; },
    ui: {
      async select(_title, options) { return options[0]; },
      async input() { throw new Error("query create must not ask for the name"); },
      async editor() { return undefined; },
      notify() {},
      setStatus() {},
      setTitle() {},
      theme: { fg(_color, text) { return text; } },
    },
  };

  await commands.get("focus").handler("alligator", ctx);

  const state = JSON.parse(readFileSync(join(cwd, ".agents", "focus", "state.json"), "utf8"));
  assert.equal(state.foci[0].name, "alligator");
  assert.equal(state.foci[0].id, "alligator");
});

test("/focus query offers exact, related, and create choices", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "focus-extension-query-"));
  mkdirSync(join(cwd, ".agents", "focus"), { recursive: true });
  writeFileSync(join(cwd, ".agents", "focus", "state.json"), JSON.stringify({
    activeFocusId: "current", lastFocusId: "current", updatedAt: null,
    foci: [
      { id: "current", name: "Current", goals: "Now" },
      { id: "alligator", name: "Alligator", goals: "Current work" },
      { id: "reptile-research", name: "Reptile research", goals: "Alligator habitats" },
    ],
  }));

  const commands = new Map();
  let message;
  const pi = {
    on() {},
    registerCommand(name, command) { commands.set(name, command); },
    sendUserMessage(value) { message = value; },
  };
  const mod = await jiti.import("../extensions/index.ts");
  mod.default(pi);
  let offered;
  let status;
  const ctx = {
    cwd,
    isIdle() { return true; },
    ui: {
      async select(_title, options) { offered = options; return options.find((item) => /exact/i.test(item)); },
      input: async () => undefined,
      editor: async () => undefined,
      notify() {},
      setStatus(key, value) { if (key === "focus") status = value; },
      setTitle() {},
      theme: { fg(_color, text) { return text; } },
    },
  };

  await commands.get("focus").handler("alligator", ctx);

  assert.equal(offered.length, 3);
  assert.ok(offered.some((item) => /exact.*alligator/i.test(item)));
  assert.ok(offered.some((item) => /reptile research/i.test(item)));
  assert.ok(offered.some((item) => /create new focus.*alligator/i.test(item)));
  assert.equal(JSON.parse(readFileSync(join(cwd, ".agents", "focus", "state.json"), "utf8")).activeFocusId, "alligator");
  assert.equal(status, "focus:Alligator");
  assert.match(message, /Return to this focus/);
});
