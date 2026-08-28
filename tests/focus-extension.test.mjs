import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  mkdirSync(join(cwd, ".agents", "focus", "foci", "ship-feature", "state"), { recursive: true });
  writeFileSync(join(cwd, ".agents", "focus", "foci", "ship-feature", "kb", "sentinel.md"), "KB-SENTINEL-SECRET");
  writeFileSync(join(cwd, ".agents", "focus", "foci", "ship-feature", "state", "sentinel.md"), "STATE-SENTINEL-SECRET");

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
  const context = first.messages[1].content[0].text;
  assert.match(context, /Project-provided goals: Finish implementation/);
  assert.ok(context.includes(`- Focus: ${join(cwd, ".agents", "focus", "foci", "ship-feature")}`));
  assert.ok(context.includes(`- Knowledge base: ${join(cwd, ".agents", "focus", "foci", "ship-feature", "kb")}`));
  assert.ok(context.includes(`- State index: ${join(cwd, ".agents", "focus", "state.json")}`));
  assert.ok(context.includes(`- Focus state directory: ${join(cwd, ".agents", "focus", "foci", "ship-feature", "state")}`));
  assert.equal(context.includes("\n- State:"), false);
  assert.equal(context.includes("KB-SENTINEL-SECRET"), false);
  assert.equal(context.includes("STATE-SENTINEL-SECRET"), false);
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

test("focus guard never mutates active tools across lifecycle activity", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "focus-extension-guard-lifecycle-"));
  mkdirSync(join(cwd, ".agents", "focus"), { recursive: true });
  writeFileSync(join(cwd, ".agents", "focus", "state.json"), JSON.stringify({
    activeFocusId: "one", lastFocusId: "one", updatedAt: null,
    foci: [
      { id: "one", name: "One", activation: { tools: ["read"] } },
      { id: "two", name: "Two", activation: { tools: ["bash"] } },
    ],
  }));
  const events = new Map();
  const commands = new Map();
  const tools = ["read", "bash", "extra"];
  let setActiveToolsCalls = 0;
  const pi = {
    on(name, handler) { events.set(name, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    getActiveTools() { return [...tools]; },
    getAllTools() { return ["read", "bash", "extra"].map((name) => ({ name })); },
    setActiveTools() { setActiveToolsCalls += 1; throw new Error("focus must not mutate active tools"); },
  };
  const mod = await jiti.import("../extensions/index.ts");
  mod.default(pi);
  const ctx = { cwd, ui: { notify() {}, setStatus() {}, setTitle() {}, theme: { fg(_color, text) { return text; } } } };

  events.get("session_start")({}, ctx);
  await commands.get("focus").handler("use two", ctx);
  await commands.get("focus").handler("off", ctx);
  await commands.get("focus").handler("use one", ctx);

  assert.equal(events.has("before_agent_start"), false);
  assert.equal(events.has("tool_result"), false);
  assert.equal(events.has("session_before_tree"), false);
  assert.equal(events.has("session_tree"), false);
  assert.equal(events.has("session_shutdown"), false);
  assert.equal(setActiveToolsCalls, 0);
  assert.deepEqual(tools, ["read", "bash", "extra"]);
});

test("guard allows absent declarations and blocks explicit empty declarations", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "focus-extension-declarations-"));
  mkdirSync(join(cwd, ".agents", "focus"), { recursive: true });
  const statePath = join(cwd, ".agents", "focus", "state.json");
  const events = new Map();
  const pi = {
    on(name, handler) { events.set(name, handler); },
    registerCommand() {},
    getActiveTools() { return ["read", "write"]; },
    getAllTools() { return [{ name: "read" }, { name: "write" }]; },
  };
  const mod = await jiti.import("../extensions/index.ts");
  mod.default(pi);
  const ctx = { cwd, ui: { notify() {}, setStatus() {}, setTitle() {}, theme: { fg(_color, text) { return text; } } } };

  writeFileSync(statePath, JSON.stringify({ activeFocusId: "none", lastFocusId: "none", updatedAt: null, foci: [{ id: "none", name: "None" }] }));
  assert.equal(events.get("tool_call")({ toolName: "read" }, ctx), undefined);
  writeFileSync(statePath, JSON.stringify({ activeFocusId: "empty", lastFocusId: "empty", updatedAt: null, foci: [{ id: "empty", name: "Empty", activation: { tools: [] } }] }));
  assert.equal(events.get("tool_call")({ toolName: "read" }, ctx).block, true);
  assert.match(events.get("tool_call")({ toolName: "read" }, ctx).reason, /not declared/);
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
  assert.deepEqual(choices[0].options, [
    "View info on current focus",
    "Switch to a past/existing focus",
    "Create a new focus",
  ]);
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

test("switch directory failure preserves focus A and its runtime policy", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "focus-extension-directory-rollback-"));
  mkdirSync(join(cwd, ".agents", "focus", "foci"), { recursive: true });
  const statePath = join(cwd, ".agents", "focus", "state.json");
  writeFileSync(statePath, JSON.stringify({
    activeFocusId: "one", lastFocusId: "one", updatedAt: null,
    foci: [
      { id: "one", name: "One", activation: { tools: ["read"] } },
      { id: "two", name: "Two", activation: { tools: ["bash"] } },
    ],
  }));
  writeFileSync(join(cwd, ".agents", "focus", "foci", "two"), "not a directory");
  const events = new Map();
  const commands = new Map();
  const tools = ["read", "bash"];
  const pi = {
    on(name, handler) { events.set(name, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    getActiveTools() { return [...tools]; },
    getAllTools() { return ["read", "bash"].map((name) => ({ name })); },
  };
  const mod = await jiti.import("../extensions/index.ts");
  mod.default(pi);
  const ctx = { cwd, ui: { notify() {}, setStatus() {}, setTitle() {}, theme: { fg(_color, text) { return text; } } } };

  events.get("session_start")({}, ctx);
  await assert.rejects(commands.get("focus").handler("use two", ctx), /expected directory/);

  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).activeFocusId, "one");
  assert.deepEqual(tools, ["read", "bash"]);
  assert.equal(events.get("tool_call")({ toolName: "bash" }, ctx).block, true);
  assert.equal(events.get("tool_call")({ toolName: "read" }, ctx), undefined);
});

test("switch status failure preserves focus A and guard policy", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "focus-extension-status-rollback-"));
  mkdirSync(join(cwd, ".agents", "focus"), { recursive: true });
  const statePath = join(cwd, ".agents", "focus", "state.json");
  writeFileSync(statePath, JSON.stringify({
    activeFocusId: "one", lastFocusId: "one", updatedAt: null,
    foci: [
      { id: "one", name: "One", activation: { tools: ["read"] } },
      { id: "two", name: "Two", activation: { tools: ["bash"] } },
    ],
  }));
  const events = new Map();
  const commands = new Map();
  const tools = ["read", "bash"];
  let failStatus = false;
  const pi = {
    on(name, handler) { events.set(name, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    getActiveTools() { return [...tools]; },
    getAllTools() { return ["read", "bash"].map((name) => ({ name })); },
  };
  const mod = await jiti.import("../extensions/index.ts");
  mod.default(pi);
  const ctx = {
    cwd,
    ui: {
      notify() {}, setStatus() { if (failStatus) throw new Error("setStatus failed"); }, setTitle() {},
      theme: { fg(_color, text) { return text; } },
    },
  };

  events.get("session_start")({}, ctx);
  failStatus = true;
  await assert.rejects(commands.get("focus").handler("use two", ctx), /setStatus failed/);

  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).activeFocusId, "one");
  assert.deepEqual(tools, ["read", "bash"]);
  assert.equal(events.get("tool_call")({ toolName: "read" }, ctx), undefined);
  assert.equal(events.get("tool_call")({ toolName: "bash" }, ctx).block, true);
});

test("guard permits only declared active registered tools", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "focus-extension-guard-inventory-"));
  mkdirSync(join(cwd, ".agents", "focus"), { recursive: true });
  writeFileSync(join(cwd, ".agents", "focus", "state.json"), JSON.stringify({
    activeFocusId: "one", lastFocusId: "one", updatedAt: null,
    foci: [{ id: "one", name: "One", activation: { tools: ["read", "inactive", "missing"] } }],
  }));
  const events = new Map();
  const pi = {
    on(name, handler) { events.set(name, handler); },
    registerCommand() {},
    getActiveTools() { return ["read", "bash"]; },
    getAllTools() { return ["read", "bash", "inactive"].map((name) => ({ name })); },
  };
  const mod = await jiti.import("../extensions/index.ts");
  mod.default(pi);
  const ctx = { cwd, ui: { notify() {}, setStatus() {}, setTitle() {}, theme: { fg(_color, text) { return text; } } } };

  assert.equal(events.get("tool_call")({ toolName: "read" }, ctx), undefined);
  assert.match(events.get("tool_call")({ toolName: "bash" }, ctx).reason, /not declared/);
  assert.match(events.get("tool_call")({ toolName: "inactive" }, ctx).reason, /not active/);
  assert.match(events.get("tool_call")({ toolName: "missing" }, ctx).reason, /not registered/);
});

test("focus management UI edits fields and activation declarations through the state transaction", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "focus-extension-edit-"));
  mkdirSync(join(cwd, ".agents", "focus"), { recursive: true });
  const statePath = join(cwd, ".agents", "focus", "state.json");
  writeFileSync(statePath, JSON.stringify({
    activeFocusId: "main", lastFocusId: "main", updatedAt: null,
    foci: [{ id: "main", name: "Main", goals: "Old goals", activation: { tools: ["read"] } }],
  }));
  const commands = new Map();
  const selections = ["Goals", "Tool declarations", "Tool declarations"];
  const editors = ["New goals", "read\nbash", ""];
  const pi = { on() {}, registerCommand(name, command) { commands.set(name, command); } };
  const mod = await jiti.import("../extensions/index.ts");
  mod.default(pi);
  const ctx = {
    cwd, hasUI: true,
    ui: {
      async select(_title, options) { const choice = selections.shift(); assert.ok(options.includes(choice)); return choice; },
      async input() { return inputs.shift(); },
      async editor() { return editors.shift(); },
      notify() {}, setStatus() {}, setTitle() {}, theme: { fg(_color, text) { return text; } },
    },
  };

  await commands.get("focus").handler("edit", ctx);
  await commands.get("focus").handler("edit", ctx);

  let focus = JSON.parse(readFileSync(statePath, "utf8")).foci[0];
  assert.equal(focus.goals, "New goals");
  assert.deepEqual(focus.activation.tools, ["read", "bash"]);
  await commands.get("focus").handler("edit", ctx);
  focus = JSON.parse(readFileSync(statePath, "utf8")).foci[0];
  assert.deepEqual(focus.activation.tools, []);
  const source = readFileSync(new URL("../extensions/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /saveFocusState|setActiveTools|ask-user/);
  assert.doesNotMatch(source, /writeFileSync\([^\n]*state\.json/);
  assert.match(source, /updateFocusState\(ctx\.cwd/);
});

test("focus management UI deletes confirmed focus metadata and directory without changing tools", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "focus-extension-delete-"));
  mkdirSync(join(cwd, ".agents", "focus", "foci", "main", "kb"), { recursive: true });
  const statePath = join(cwd, ".agents", "focus", "state.json");
  writeFileSync(statePath, JSON.stringify({
    activeFocusId: "main", lastFocusId: "main", updatedAt: null,
    foci: [{ id: "main", name: "Main", activation: { tools: ["read"] } }],
  }));
  const commands = new Map();
  const selections = ["Main (main)", "Cancel", "Main (main)", "Delete “Main”"];
  let setActiveToolsCalls = 0;
  const pi = {
    on() {}, registerCommand(name, command) { commands.set(name, command); },
    setActiveTools() { setActiveToolsCalls += 1; },
  };
  const mod = await jiti.import("../extensions/index.ts");
  mod.default(pi);
  const ctx = {
    cwd, hasUI: true,
    ui: {
      async select(_title, options) { const choice = selections.shift(); assert.ok(options.includes(choice)); return choice; },
      input: async () => undefined, editor: async () => undefined, notify() {}, setStatus() {}, setTitle() {},
      theme: { fg(_color, text) { return text; } },
    },
  };

  await commands.get("focus").handler("delete", ctx);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).activeFocusId, "main");
  assert.equal(existsSync(join(cwd, ".agents", "focus", "foci", "main")), true);
  assert.equal(setActiveToolsCalls, 0);
  await commands.get("focus").handler("delete", ctx);

  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.activeFocusId, null);
  assert.equal(state.lastFocusId, null);
  assert.deepEqual(state.foci, []);
  assert.equal(existsSync(join(cwd, ".agents", "focus", "foci", "main")), false);
  assert.equal(setActiveToolsCalls, 0);
});

test("focus KB UI creates, edits, and confirms deletion of project-local Markdown", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "focus-extension-kb-"));
  mkdirSync(join(cwd, ".agents", "focus"), { recursive: true });
  writeFileSync(join(cwd, ".agents", "focus", "state.json"), JSON.stringify({
    activeFocusId: "main", lastFocusId: "main", updatedAt: null, foci: [{ id: "main", name: "Main" }],
  }));
  const commands = new Map();
  const selections = ["Create new entry", "plan", "Edit entry", "plan", "Delete entry", "Delete “plan”"];
  const inputs = ["Plan"];
  const editors = ["# draft", "# revised"];
  const pi = { on() {}, registerCommand(name, command) { commands.set(name, command); } };
  const mod = await jiti.import("../extensions/index.ts");
  mod.default(pi);
  const ctx = {
    cwd, hasUI: true,
    ui: {
      async select(_title, options) { const choice = selections.shift(); assert.ok(options.includes(choice)); return choice; },
      async input() { return inputs.shift(); }, async editor() { return editors.shift(); },
      notify() {}, setStatus() {}, setTitle() {}, theme: { fg(_color, text) { return text; } },
    },
  };

  await commands.get("focus").handler("kb", ctx);
  assert.equal(readFileSync(join(cwd, ".agents", "focus", "foci", "main", "kb", "plan.md"), "utf8"), "# draft");
  await commands.get("focus").handler("kb", ctx);
  assert.equal(readFileSync(join(cwd, ".agents", "focus", "foci", "main", "kb", "plan.md"), "utf8"), "# revised");
  await commands.get("focus").handler("kb", ctx);
  assert.equal(existsSync(join(cwd, ".agents", "focus", "foci", "main", "kb", "plan.md")), false);
});

test("focus status is truthful and use/create share chooser activation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "focus-extension-status-"));
  mkdirSync(join(cwd, ".agents", "focus"), { recursive: true });
  writeFileSync(join(cwd, ".agents", "focus", "state.json"), JSON.stringify({
    activeFocusId: "main", lastFocusId: "main", updatedAt: null,
    foci: [{ id: "main", name: "Main", activation: { tools: ["read", "process", "subagent"] } }],
  }));
  const commands = new Map();
  const notices = [];
  const messages = [];
  const pi = {
    on() {}, registerCommand(name, command) { commands.set(name, command); },
    sendUserMessage(message) { messages.push(message); },
    getActiveTools() { return ["read"]; }, getAllTools() { return [{ name: "read" }, { name: "process" }]; },
  };
  const mod = await jiti.import("../extensions/index.ts");
  mod.default(pi);
  const ctx = {
    cwd, hasUI: true, isIdle() { return true; },
    ui: {
      select: async () => undefined, input: async () => "New", editor: async () => undefined,
      notify(message) { notices.push(message); }, setStatus() {}, setTitle() {}, theme: { fg(_color, text) { return text; } },
    },
  };

  await commands.get("focus").handler("status", ctx);
  assert.match(notices[0], /Focus paths/);
  assert.ok(notices[0].includes(`- Focus: ${join(cwd, ".agents", "focus", "foci", "main")}`));
  assert.ok(notices[0].includes(`- Knowledge base: ${join(cwd, ".agents", "focus", "foci", "main", "kb")}`));
  assert.ok(notices[0].includes(`- State index: ${join(cwd, ".agents", "focus", "state.json")}`));
  assert.ok(notices[0].includes(`- Focus state directory: ${join(cwd, ".agents", "focus", "foci", "main", "state")}`));
  assert.equal(notices[0].includes("\n- State:"), false);
  assert.match(notices[0], /Declared: read, process, subagent/);
  assert.match(notices[0], /Active \+ registered: read/);
  assert.match(notices[0], /Registered but inactive \(available for explicit activation\): process/);
  assert.match(notices[0], /Unregistered\/unavailable: subagent/);
  assert.match(notices[0], /Requires explicit invocation/);
  assert.match(notices[0], /do not run loadouts/);
  await commands.get("focus").handler("use main", ctx);
  await commands.get("focus").handler("new", ctx);
  assert.equal(messages.filter((message) => /Return to this focus/.test(message)).length, 2);
});

test("focus command avoids dialogs when the host has no UI", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "focus-extension-no-ui-"));
  const commands = new Map();
  const notices = [];
  const pi = { on() {}, registerCommand(name, command) { commands.set(name, command); } };
  const mod = await jiti.import("../extensions/index.ts");
  mod.default(pi);
  await commands.get("focus").handler("", {
    cwd, hasUI: false,
    ui: {
      select: async () => { throw new Error("must not open a dialog"); },
      input: async () => { throw new Error("must not open a dialog"); },
      editor: async () => { throw new Error("must not open a dialog"); },
      notify(message) { notices.push(message); }, setStatus() {}, setTitle() {}, theme: { fg(_color, text) { return text; } },
    },
  });
  assert.match(notices[0], /interactive focus management is unavailable/i);
});

test("focus help and skill describe automatic context with explicit declarative intents", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "focus-extension-help-"));
  const commands = new Map();
  const notices = [];
  const pi = { on() {}, registerCommand(name, command) { commands.set(name, command); } };
  const mod = await jiti.import("../extensions/index.ts");
  mod.default(pi);
  await commands.get("focus").handler("help", {
    cwd, hasUI: true,
    ui: {
      select: async () => undefined, input: async () => undefined, editor: async () => undefined,
      notify(message) { notices.push(message); }, setStatus() {}, setTitle() {}, theme: { fg(_color, text) { return text; } },
    },
  });
  assert.match(notices[0], /injected automatically/);
  assert.match(notices[0], /explicit tool calls/);
  assert.match(notices[0], /project-local/);
  assert.match(notices[0], /\/focus edit/);
  assert.match(notices[0], /\/focus delete/);
  assert.match(notices[0], /\/focus kb/);
  const skill = readFileSync(new URL("../skills/focus/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /automatically/i);
  assert.match(skill, /explicit tool calls/i);
  assert.match(skill, /project-local/i);
});

test("guard tracks external active sets without changing them", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "focus-extension-external-inventory-"));
  mkdirSync(join(cwd, ".agents", "focus"), { recursive: true });
  writeFileSync(join(cwd, ".agents", "focus", "state.json"), JSON.stringify({
    activeFocusId: "one", lastFocusId: "one", updatedAt: null,
    foci: [{ id: "one", name: "One", activation: { tools: ["read", "bash"] } }],
  }));
  const events = new Map();
  const tools = ["read"];
  const pi = {
    on(name, handler) { events.set(name, handler); },
    registerCommand() {},
    getActiveTools() { return [...tools]; },
    getAllTools() { return ["read", "bash", "extra"].map((name) => ({ name })); },
  };
  const mod = await jiti.import("../extensions/index.ts");
  mod.default(pi);
  const ctx = { cwd, ui: { notify() {}, setStatus() {}, setTitle() {}, theme: { fg(_color, text) { return text; } } } };

  assert.equal(events.get("tool_call")({ toolName: "read" }, ctx), undefined);
  assert.match(events.get("tool_call")({ toolName: "bash" }, ctx).reason, /not active/);
  assert.deepEqual(tools, ["read"]);
  tools.splice(0, tools.length, "read", "bash", "extra");
  assert.equal(events.get("tool_call")({ toolName: "bash" }, ctx), undefined);
  assert.match(events.get("tool_call")({ toolName: "extra" }, ctx).reason, /not declared/);
  assert.deepEqual(tools, ["read", "bash", "extra"]);
  tools.splice(0, tools.length);
  assert.match(events.get("tool_call")({ toolName: "read" }, ctx).reason, /not active/);
  assert.deepEqual(tools, []);
});
