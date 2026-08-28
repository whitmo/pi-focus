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

  const events = new Map();
  const commands = new Map();
  const pi = {
    on(name, handler) { events.set(name, handler); },
    registerCommand(name, command) { commands.set(name, command); },
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
      setStatus(_key, value) { status = value; },
      setTitle() {},
      theme: { fg(_color, text) { return `bright:${text}`; } },
    },
  };

  events.get("session_start")({}, ctx);
  assert.equal(status, "bright:focus:Ship feature");

  const result = events.get("before_agent_start")({ systemPrompt: "base" }, { cwd });
  assert.match(result.systemPrompt, /## Current Focus/);
  assert.match(result.systemPrompt, /Focus: Ship feature/);
  assert.match(result.systemPrompt, /Goals: Finish implementation/);
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
      setStatus(_key, value) { status = value; },
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
      setStatus(_key, value) { status = value; },
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
