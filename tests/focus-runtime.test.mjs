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
  state: "/project/.agents/focus/state.json",
};

test("buildFocusContext bounds project text, names paths, and never reads KB content", async () => {
  const { activationCapabilities, buildFocusContext } = await runtime();
  const context = buildFocusContext(focus, paths, activationCapabilities(["read", "loadout_profile"]));

  assert.match(context, /Project-provided goals:/);
  assert.match(context, /Project-provided planning docs: plan-0\.md/);
  assert.match(context, new RegExp(paths.kb));
  assert.match(context, new RegExp(paths.state));
  assert.match(context, /Declared: read, loadout_profile, missing/);
  assert.match(context, /Available: read, loadout_profile/);
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
  }, paths, activationCapabilities(["read"]));

  assert.ok(context.length <= 4_000);
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

test("activationCapabilities reports availability without invoking declared resources", async () => {
  const { activationCapabilities } = await runtime();
  const capabilities = activationCapabilities(["read", "process"]);

  assert.deepEqual(capabilities.availableTools, ["read", "process"]);
  assert.equal(capabilities.loadoutProfile.available, false);
  assert.equal(capabilities.process.available, true);
  assert.equal(capabilities.subagent.available, false);
  assert.match(capabilities.loadoutProfile.status, /requires explicit invocation/i);
});
