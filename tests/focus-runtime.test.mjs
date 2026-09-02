import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { normalizeFocusPathSnapshot } from "../extensions/focus-session.mjs";

const runtime = () => import("../extensions/focus-runtime.mjs");

const focus = {
  kind: "focus",
  id: "strict-focus",
  parentId: null,
  name: "Strict focus",
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:03.000Z",
  revision: 3,
  goals: "Ship captured focus context",
  scope: "Keep focus behavior narrow",
  constraints: "No automatic resource invocation",
  planningDocs: ["focus-plan.md"],
  refs: ["FOCUS-REF"],
  notes: ["focus note"],
  activation: {
    tools: ["read", "grep", "loadout_profile", "missing"],
    loadoutPreset: "focus-preset",
    monitors: ["focus monitor"],
    scripts: ["focus script"],
    agents: ["focus agent"],
  },
};
const subfocus = {
  kind: "subfocus",
  id: "runtime-slice",
  parentId: focus.id,
  name: "Runtime slice",
  createdAt: "2026-09-02T00:00:01.000Z",
  updatedAt: "2026-09-02T00:00:07.000Z",
  revision: 7,
  goals: "Render the subfocus snapshot",
  scope: "Runtime and focused tests only",
  constraints: "Do not read mutable catalog data",
  planningDocs: ["runtime-plan.md"],
  refs: ["RUNTIME-REF"],
  notes: ["runtime note"],
  activation: {
    tools: ["grep", "write", "process"],
    loadoutPreset: "subfocus-preset",
    monitors: ["subfocus monitor"],
    scripts: ["subfocus script"],
    agents: ["subfocus agent"],
  },
};
const path = normalizeFocusPathSnapshot({ focus, subfocus });
const paths = {
  focus: {
    container: "/project/.agents/focus/foci/strict-focus",
    kb: "/project/.agents/focus/foci/strict-focus/kb",
    state: "/project/.agents/focus/foci/strict-focus/state",
  },
  subfocus: {
    container: "/project/.agents/focus/foci/strict-focus/subfoci/runtime-slice",
    kb: "/project/.agents/focus/foci/strict-focus/subfoci/runtime-slice/kb",
    state: "/project/.agents/focus/foci/strict-focus/subfoci/runtime-slice/state",
  },
};

const noPolicy = { activation: undefined };
const noPolicySub = { activation: undefined };
const tools = (...names) => ({ activation: { tools: names } });

test("effectiveToolDeclaration intersects focus and subfocus declarations", async () => {
  const { effectiveToolDeclaration } = await runtime();

  assert.equal(effectiveToolDeclaration({ focus: noPolicy, subfocus: noPolicySub }), undefined);
  assert.deepEqual(effectiveToolDeclaration({ focus: tools("read", "grep"), subfocus: tools("grep", "write") }), ["grep"]);
  assert.deepEqual(effectiveToolDeclaration({ focus: tools("read"), subfocus: tools() }), []);
});

test("resolvePathToolPolicy preserves registered and active host filtering", async () => {
  const { resolvePathToolPolicy } = await runtime();

  assert.deepEqual(resolvePathToolPolicy(path, ["grep", "write", "process"], ["grep", "process"]), {
    declared: ["grep"],
    allowed: ["grep"],
    unavailable: [],
  });
  assert.equal(resolvePathToolPolicy({ focus: noPolicy, subfocus: noPolicySub }, ["read"], ["read"]), null);
});

test("buildFocusContext renders captured focus and subfocus data without reading the catalog or KB", async () => {
  const { activationCapabilities, buildFocusContext } = await runtime();
  const context = buildFocusContext(
    path,
    paths,
    activationCapabilities(["read", "grep", "loadout_profile", "process"], ["read", "grep", "loadout_profile"]),
  );

  assert.match(context, /Focus: Strict focus/);
  assert.match(context, /Focus captured revision: 3/);
  assert.match(context, /Project-provided focus goals: Ship captured focus context/);
  assert.match(context, /Project-provided focus scope: Keep focus behavior narrow/);
  assert.match(context, /Project-provided focus constraints: No automatic resource invocation/);
  assert.match(context, /Project-provided focus planning docs: focus-plan\.md/);
  assert.match(context, /Project-provided focus references: FOCUS-REF/);
  assert.match(context, /Project-provided focus notes: focus note/);
  assert.match(context, /Subfocus: Runtime slice/);
  assert.match(context, /Subfocus captured revision: 7/);
  assert.match(context, /Project-provided subfocus goals: Render the subfocus snapshot/);
  assert.match(context, /Project-provided subfocus scope: Runtime and focused tests only/);
  assert.match(context, /Project-provided subfocus constraints: Do not read mutable catalog data/);
  assert.match(context, /Project-provided subfocus planning docs: runtime-plan\.md/);
  assert.match(context, /Project-provided subfocus references: RUNTIME-REF/);
  assert.match(context, /Project-provided subfocus notes: runtime note/);
  assert.match(context, new RegExp(paths.focus.kb));
  assert.match(context, new RegExp(paths.focus.state));
  assert.match(context, new RegExp(paths.subfocus.kb));
  assert.match(context, new RegExp(paths.subfocus.state));
  assert.doesNotMatch(context, /state\.json|State index:/);
  assert.match(context, /Focus tools: read, grep, loadout_profile, missing/);
  assert.match(context, /Focus loadout preset intent: focus-preset/);
  assert.match(context, /Focus monitor runbooks: focus monitor/);
  assert.match(context, /Focus script runbooks: focus script/);
  assert.match(context, /Focus agent runbooks: focus agent/);
  assert.match(context, /Subfocus tools: grep, write, process/);
  assert.match(context, /Subfocus loadout preset intent: subfocus-preset/);
  assert.match(context, /Subfocus monitor runbooks: subfocus monitor/);
  assert.match(context, /Subfocus script runbooks: subfocus script/);
  assert.match(context, /Subfocus agent runbooks: subfocus agent/);
  assert.match(context, /Effective declared tools: grep/);
  assert.match(context, /Active \+ registered: grep/);
  assert.match(context, /Requires explicit invocation:/);
  assert.ok(context.length <= 4_000);
  assert.equal(context.includes("KB-SENTINEL-SECRET"), false);

  const source = readFileSync(new URL("../extensions/focus-runtime.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /focus-store|readKnowledgeEntry|listKnowledgeEntries/);
});

test("buildFocusContext keeps the hard total bound for a valid large snapshot", async () => {
  const { activationCapabilities, buildFocusContext } = await runtime();
  const large = normalizeFocusPathSnapshot({
    focus: {
      ...focus,
      goals: "G".repeat(500),
      planningDocs: Array.from({ length: 8 }, () => "D".repeat(500)),
      refs: Array.from({ length: 8 }, () => "R".repeat(500)),
      notes: Array.from({ length: 8 }, () => "N".repeat(500)),
    },
    subfocus: null,
  });
  const context = buildFocusContext(large, { focus: paths.focus, subfocus: null }, activationCapabilities(["read"], ["read"]));

  assert.ok(context.length <= 4_000);
});

test("resolveToolPolicy retains guard-only declaration semantics", async () => {
  const { resolveToolPolicy } = await runtime();

  assert.equal(resolveToolPolicy(undefined, ["read"], ["read"]), null);
  assert.deepEqual(resolveToolPolicy([], ["read"], ["read"]), {
    declared: [], allowed: [], unavailable: [],
  });
  assert.deepEqual(resolveToolPolicy(["bash", "read", "bash", "missing"], ["read", "bash", "inactive"], ["read", "bash"]), {
    declared: ["bash", "read", "missing"],
    allowed: ["bash", "read"],
    unavailable: ["missing"],
  });
  assert.deepEqual(resolveToolPolicy(["inactive"], ["inactive"], []), {
    declared: ["inactive"], allowed: [], unavailable: ["inactive"],
  });
});

test("activationCapabilities retains active, inactive, and unregistered status", async () => {
  const { activationCapabilities } = await runtime();
  const capabilities = activationCapabilities(["read", "loadout_profile", "process"], ["read", "loadout_profile"]);

  assert.deepEqual(capabilities.registeredTools, ["read", "loadout_profile", "process"]);
  assert.deepEqual(capabilities.activeTools, ["read", "loadout_profile"]);
  assert.deepEqual(capabilities.availableTools, ["read", "loadout_profile"]);
  assert.equal(capabilities.loadoutProfile.active, true);
  assert.match(capabilities.loadoutProfile.status, /active and registered/i);
  assert.equal(capabilities.process.available, true);
  assert.equal(capabilities.process.active, false);
  assert.match(capabilities.process.status, /registered but inactive.*explicit activation/i);
  assert.equal(capabilities.subagent.available, false);
  assert.match(capabilities.subagent.status, /unregistered\/unavailable/i);
});
