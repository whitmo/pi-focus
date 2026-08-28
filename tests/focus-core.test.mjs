import assert from "node:assert/strict";
import test from "node:test";

import {
  addFocusNote,
  createEmptyState,
  createFocus,
  createSubfocus,
  deleteFocus,
  getActiveFocus,
  normalizeFocusState,
  updateFocus,
  findMatchingFoci,
  setFocusOff,
} from "../extensions/focus-core.mjs";

test("keeps exact matches and caps related matches at five in stored order", () => {
  const foci = [
    { id: "related-1", name: "Related 1", goals: "Alligator" },
    { id: "alligator", name: "Alligator", goals: "Habitat" },
    { id: "related-2", name: "Related 2", goals: "Alligator" },
    { id: "related-3", name: "Related 3", goals: "Alligator" },
    { id: "related-4", name: "Related 4", goals: "Alligator" },
    { id: "related-5", name: "Related 5", goals: "Alligator" },
    { id: "related-6", name: "Related 6", goals: "Alligator" },
    { id: "related-7", name: "Related 7", goals: "Alligator" },
  ];

  assert.deepEqual(findMatchingFoci(foci, "ALLIGATOR").map((focus) => focus.id), [
    "alligator",
    "related-1",
    "related-2",
    "related-3",
    "related-4",
    "related-5",
  ]);
});

test("normalizes legacy focus records with safe activation defaults", () => {
  const state = normalizeFocusState({
    activeFocusId: "legacy",
    lastFocusId: "legacy",
    foci: [{ id: "legacy", name: "Legacy", goals: "Keep working" }],
    updatedAt: "2026-08-28T00:00:00.000Z",
  });

  assert.deepEqual(state.foci[0].activation, undefined);
  assert.equal(state.foci[0].subfocuses.length, 0);
  assert.equal(state.foci[0].activeSubfocusId, null);
});

test("preserves intentional empty activation tools but strips executable fields", () => {
  let state = createEmptyState();
  state = createFocus(state, { name: "Basic" }, "2026-08-28T00:00:00.000Z");
  assert.equal(state.foci[0].activation, undefined);

  state = createFocus(state, {
    name: "Restricted",
    activation: { tools: [], command: "rm -rf /" },
    command: "rm -rf /",
    extensionPath: "/tmp/evil.mjs",
    agent: { command: "evil" },
  }, "2026-08-28T00:00:01.000Z");

  assert.deepEqual(state.foci[1].activation, { tools: [] });
  assert.equal("command" in state.foci[1], false);
  assert.equal("extensionPath" in state.foci[1], false);
  assert.equal("agent" in state.foci[1], false);
});

test("normalizes bounded inert runbooks, preserves them across mutations, and retires IDs", () => {
  const monitors = Array.from({ length: 10 }, (_, index) => `monitor-${index}`);
  const scripts = Array.from({ length: 10 }, (_, index) => `script-${index}`);
  const agents = Array.from({ length: 10 }, (_, index) => `agent-${index}`);
  let state = createFocus(createEmptyState(), {
    name: "Foo",
    activation: {
      loadoutPreset: "team-default",
      monitors,
      scripts,
      agents,
      command: "must be stripped",
    },
  }, "2026-08-28T00:00:00.000Z");

  const declarations = {
    loadoutPreset: "team-default",
    monitors: monitors.slice(0, 8),
    scripts: scripts.slice(0, 8),
    agents: agents.slice(0, 8),
  };
  assert.deepEqual(state.foci[0].activation, declarations);

  state = normalizeFocusState(JSON.parse(JSON.stringify(state)));
  state = addFocusNote(state, "Keep this context", "2026-08-28T00:00:01.000Z");
  state = updateFocus(state, "foo", {
    activation: { tools: ["bash"] },
  }, "2026-08-28T00:00:02.000Z");
  assert.deepEqual(state.foci[0].activation, { tools: ["bash"], ...declarations });

  state = deleteFocus(state, "foo", "2026-08-28T00:00:03.000Z");
  assert.deepEqual(state.retiredFocusIds, ["foo"]);
  state = createFocus(state, { name: "Foo" }, "2026-08-28T00:00:04.000Z");
  assert.equal(state.foci[0].id, "foo-2");
});

test("rejects invalid activation updates before preserving existing declarations", () => {
  const state = createFocus(createEmptyState(), { name: "Safe", activation: { monitors: ["watch CI"] } });

  assert.throws(() => updateFocus(state, "safe", { activation: null }), /invalid activation metadata/i);
  assert.throws(() => updateFocus(state, "safe", { activation: "not declarations" }), /invalid activation metadata/i);
});

test("updates and deletes focus records without clearing unrelated IDs", () => {
  let state = createEmptyState();
  state = createFocus(state, { name: "First" }, "2026-08-28T00:00:00.000Z");
  state = createFocus(state, { name: "Second" }, "2026-08-28T00:00:01.000Z");
  state = updateFocus(state, "first", { goals: "Updated", command: "ignored" }, "2026-08-28T00:00:02.000Z");
  state = deleteFocus(state, "first", "2026-08-28T00:00:03.000Z");

  assert.deepEqual(state.foci.map((focus) => focus.id), ["second"]);
  assert.equal(state.activeFocusId, "second");
  assert.equal(state.lastFocusId, "second");
});

test("creates, expands, narrows, and deactivates focus state", () => {
  let state = createEmptyState();

  state = createFocus(state, {
    name: "Release planning",
    goals: "Ship the release checklist",
    scope: "Web app",
    constraints: "Small diff only",
    planningDocs: ["docs/release-plan.md"],
    refs: ["Issue #123"],
  }, "2026-08-05T12:00:00.000Z");

  assert.equal(state.activeFocusId, "release-planning");
  assert.equal(state.lastFocusId, "release-planning");
  assert.equal(getActiveFocus(state).name, "Release planning");

  state = addFocusNote(state, "Added issue #42", "2026-08-05T12:01:00.000Z");
  assert.deepEqual(getActiveFocus(state).notes, ["Added issue #42"]);

  state = createSubfocus(state, {
    name: "PR review",
    goals: "Address blocking comments",
    scope: "Only reviewed lines",
    constraints: "No unrelated cleanup",
  }, "2026-08-05T12:02:00.000Z");

  const active = getActiveFocus(state);
  assert.equal(active.activeSubfocusId, "pr-review");
  assert.equal(active.subfocuses[0].name, "PR review");

  state = setFocusOff(state, "2026-08-05T12:03:00.000Z");
  assert.equal(state.activeFocusId, null);
  assert.equal(state.lastFocusId, "release-planning");
});
