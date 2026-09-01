import assert from "node:assert/strict";
import test from "node:test";

const runtime = () => import("../extensions/focus-runtime.mjs");

const focus = {
  id: "strict-focus",
  name: "Strict focus",
  goals: "G".repeat(900),
  scope: "Keep it narrow",
  constraints: "No automatic resource invocation",
  planningDocs: Array.from({ length: 20 }, (_, index) => `plan-${index}.md`),
  refs: Array.from({ length: 20 }, (_, index) => `REF-${index}`),
  notes: Array.from({ length: 20 }, (_, index) => `note-${index}`),
  activation: { tools: ["read", "loadout_profile", "missing"] },
};

const paths = {
  focus: "/project/.agents/focus/foci/strict-focus",
  kb: "/project/.agents/focus/foci/strict-focus/kb",
  stateIndex: "/project/.agents/focus/state.json",
  focusState: "/project/.agents/focus/foci/strict-focus/state",
};

test("buildFocusContext bounds project text, names paths, and never reads KB content", async () => {
  const { activationCapabilities, buildFocusContext } = await runtime();
  const context = buildFocusContext(focus, paths, activationCapabilities(["read", "loadout_profile"], ["read", "loadout_profile"]));

  assert.match(context, /Project-provided goals:/);
  assert.match(context, /Project-provided planning docs: plan-0\.md/);
  assert.match(context, new RegExp(paths.kb));
  assert.match(context, new RegExp(paths.stateIndex));
  assert.match(context, new RegExp(paths.focusState));
  assert.match(context, /State index:/);
  assert.match(context, /Focus state directory:/);
  assert.doesNotMatch(context, /\n- State:/);
  assert.match(context, /Declared: read, loadout_profile, missing/);
  assert.match(context, /Active \+ registered: read, loadout_profile/);
  assert.match(context, /Requires explicit invocation:/);
  assert.ok(context.length < 5_000);
  assert.equal(context.includes("G".repeat(900)), false);
  assert.equal(context.includes("KB-SENTINEL-SECRET"), false);
});

test("buildFocusContext has a hard total bound even with many oversized fields", async () => {
  const { activationCapabilities, buildFocusContext } = await runtime();
  const context = buildFocusContext({
    ...focus,
    planningDocs: Array.from({ length: 20 }, () => "D".repeat(900)),
    refs: Array.from({ length: 20 }, () => "R".repeat(900)),
    notes: Array.from({ length: 20 }, () => "N".repeat(900)),
  }, paths, activationCapabilities(["read"], ["read"]));

  assert.ok(context.length <= 4_000);
});

test("buildFocusContext renders inert runbook declarations", async () => {
  const { activationCapabilities, buildFocusContext } = await runtime();
  const context = buildFocusContext({
    ...focus,
    activation: {
      tools: ["read"],
      loadoutPreset: "team-default",
      monitors: ["watch CI"],
      scripts: ["refresh fixtures"],
      agents: ["reviewer"],
    },
  }, paths, activationCapabilities(["read"], ["read"]));

  assert.match(context, /Loadout preset intent: team-default/);
  assert.match(context, /Monitor runbooks: watch CI/);
  assert.match(context, /Script runbooks: refresh fixtures/);
  assert.match(context, /Agent runbooks: reviewer/);
  assert.match(context, /do not run loadouts, processes, scripts, or subagents/);
});

test("resolveToolPolicy distinguishes absent, allowed, and unavailable declarations", async () => {
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

test("activationCapabilities distinguishes active, inactive registered, and unregistered optional capabilities", async () => {
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

test("buildFocusContext distinguishes active, inactive registered, and unavailable declarations", async () => {
  const { activationCapabilities, buildFocusContext } = await runtime();
  const context = buildFocusContext({ ...focus, activation: { tools: ["read", "process", "subagent"] } }, paths, activationCapabilities(
    ["read", "loadout_profile", "process"],
    ["read", "loadout_profile"],
  ));

  assert.match(context, /Active \+ registered: read/);
  assert.match(context, /Registered but inactive \(available for explicit activation\): process/);
  assert.match(context, /Unregistered\/unavailable: subagent/);
  assert.match(context, /loadout_profile active and registered/);
  assert.match(context, /process registered but inactive; available for explicit activation/);
  assert.match(context, /subagent unregistered\/unavailable/);
});
