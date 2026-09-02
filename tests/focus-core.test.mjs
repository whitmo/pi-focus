import assert from "node:assert/strict";
import test from "node:test";

import {
  addFocusNote,
  addSubfocusNote,
  createEmptyCatalog,
  createFocus,
  createSubfocus,
  findFocusPath,
  findMatchingFoci,
  normalizeFocusCatalog,
  normalizeLegacyFocusState,
  retireFocus,
  summarizeFocusPath,
  updateFocus,
  updateSubfocus,
} from "../extensions/focus-core.mjs";

const NOW = "2026-09-02T00:00:00.000Z";
const LATER = "2026-09-02T00:00:01.000Z";
const LATEST = "2026-09-02T00:00:02.000Z";
const LAST = "2026-09-02T00:00:03.000Z";

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

test("normalizes catalogs without exposing legacy selection fields", () => {
  const catalog = normalizeFocusCatalog({
    activeFocusId: "legacy",
    lastFocusId: "legacy",
    foci: [{
      id: "legacy",
      name: "Legacy",
      goals: "Keep working",
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    }],
    retiredFocusIds: [],
  });

  assert.deepEqual(catalog.foci[0].activation, undefined);
  assert.equal(catalog.foci[0].subfocuses.length, 0);
  assert.equal("activeFocusId" in catalog, false);
  assert.equal("lastFocusId" in catalog, false);
});

test("normalizes legacy state with nullable timestamps for deterministic migration", () => {
  const state = normalizeLegacyFocusState({
    activeFocusId: "legacy",
    lastFocusId: "legacy",
    foci: [{
      id: "legacy",
      name: "Legacy",
      createdAt: null,
      updatedAt: null,
      subfocuses: [{
        id: "legacy-child",
        name: "Legacy child",
        createdAt: null,
        updatedAt: null,
      }],
    }],
    updatedAt: null,
  });

  assert.equal(state.activeFocusId, "legacy");
  assert.equal(state.lastFocusId, "legacy");
  assert.equal(state.updatedAt, null);
  assert.equal(state.foci[0].createdAt, null);
  assert.equal(state.foci[0].updatedAt, null);
  assert.equal(state.foci[0].subfocuses[0].createdAt, null);
  assert.equal(state.foci[0].subfocuses[0].updatedAt, null);
});

test("creates and updates revisioned focus records without selection state", () => {
  const created = createFocus(createEmptyCatalog(), { name: "Focus A" }, NOW);
  assert.equal(created.focus.revision, 1);
  assert.equal(created.focus.createdAt, NOW);
  assert.equal(created.catalog.foci[0].id, "focus-a");
  assert.equal("activeFocusId" in created.catalog, false);

  const updated = updateFocus(
    created.catalog,
    created.focus.id,
    { createdAt: NOW, revision: 1 },
    { goals: "new goal" },
    LATER,
  );
  assert.equal(updated.focus.revision, 2);
  assert.equal(updated.focus.goals, "new goal");
  assert.throws(
    () => updateFocus(
      updated.catalog,
      updated.focus.id,
      { createdAt: NOW, revision: 1 },
      { scope: "stale" },
      LATER,
    ),
    /stale catalog revision/,
  );
  assert.throws(
    () => updateFocus(
      updated.catalog,
      updated.focus.id,
      { createdAt: LATER, revision: 2 },
      { scope: "replaced record" },
      LATEST,
    ),
    /stale catalog revision/,
  );
});

test("normalizes bounded inert activation declarations across focus mutations", () => {
  const monitors = Array.from({ length: 10 }, (_, index) => `monitor-${index}`);
  const scripts = Array.from({ length: 10 }, (_, index) => `script-${index}`);
  const agents = Array.from({ length: 10 }, (_, index) => `agent-${index}`);
  const created = createFocus(createEmptyCatalog(), {
    name: "Foo",
    activation: {
      loadoutPreset: "team-default",
      monitors,
      scripts,
      agents,
      command: "must be stripped",
    },
  }, NOW);

  const declarations = {
    loadoutPreset: "team-default",
    monitors: monitors.slice(0, 8),
    scripts: scripts.slice(0, 8),
    agents: agents.slice(0, 8),
  };
  assert.deepEqual(created.focus.activation, declarations);

  const noted = addFocusNote(
    created.catalog,
    created.focus.id,
    { createdAt: NOW, revision: 1 },
    "Keep this context",
    LATER,
  );
  const updated = updateFocus(
    noted.catalog,
    noted.focus.id,
    { createdAt: NOW, revision: 2 },
    { activation: { tools: ["bash"] } },
    LATEST,
  );
  assert.deepEqual(updated.focus.activation, { tools: ["bash"], ...declarations });
  assert.deepEqual(updated.focus.notes, ["Keep this context"]);

  assert.throws(
    () => updateFocus(
      updated.catalog,
      updated.focus.id,
      { createdAt: NOW, revision: 3 },
      { activation: null },
      LAST,
    ),
    /invalid activation metadata/i,
  );
  assert.throws(
    () => updateFocus(
      updated.catalog,
      updated.focus.id,
      { createdAt: NOW, revision: 3 },
      { activation: "not declarations" },
      LAST,
    ),
    /invalid activation metadata/i,
  );
});

test("retires focus IDs with revision checks and never reuses them", () => {
  const created = createFocus(createEmptyCatalog(), { name: "Foo" }, NOW);
  assert.throws(
    () => retireFocus(created.catalog, created.focus.id, { createdAt: NOW, revision: 2 }),
    /stale catalog revision/,
  );

  const retired = retireFocus(
    created.catalog,
    created.focus.id,
    { createdAt: NOW, revision: 1 },
  );
  assert.deepEqual(retired.catalog.retiredFocusIds, ["foo"]);
  assert.deepEqual(retired.catalog.foci, []);

  const replacement = createFocus(retired.catalog, { name: "Foo" }, LATER);
  assert.equal(replacement.focus.id, "foo-2");
});

test("subfocuses own revisions, context, activation, notes, and path snapshots", () => {
  const created = createFocus(createEmptyCatalog(), {
    name: "Focus A",
    goals: "parent goal",
  }, NOW);
  const childCreated = createSubfocus(created.catalog, created.focus.id, {
    name: "Subfocus A",
    goals: "child goal",
    scope: "child scope",
    constraints: "child constraint",
    planningDocs: ["docs/child.md"],
    refs: ["DISC-1000"],
    notes: ["first note"],
    activation: { tools: [], command: "must be stripped" },
  }, LATER);

  assert.equal(childCreated.focus.revision, 1);
  assert.equal(childCreated.focus.updatedAt, NOW);
  assert.equal(childCreated.subfocus.revision, 1);
  assert.equal(childCreated.subfocus.parentId, created.focus.id);
  assert.deepEqual(childCreated.subfocus.activation, { tools: [] });
  assert.deepEqual(childCreated.subfocus.planningDocs, ["docs/child.md"]);
  assert.deepEqual(childCreated.subfocus.refs, ["DISC-1000"]);

  const childUpdated = updateSubfocus(
    childCreated.catalog,
    created.focus.id,
    childCreated.subfocus.id,
    { createdAt: LATER, revision: 1 },
    { goals: "updated child goal", activation: { tools: ["bash"] } },
    LATEST,
  );
  assert.equal(childUpdated.focus.revision, 1);
  assert.equal(childUpdated.subfocus.revision, 2);
  assert.equal(childUpdated.subfocus.goals, "updated child goal");
  assert.deepEqual(childUpdated.subfocus.activation, { tools: ["bash"] });
  assert.throws(
    () => updateSubfocus(
      childUpdated.catalog,
      created.focus.id,
      childUpdated.subfocus.id,
      { createdAt: LATER, revision: 1 },
      { scope: "stale" },
      LAST,
    ),
    /stale catalog revision/,
  );

  const noted = addSubfocusNote(
    childUpdated.catalog,
    created.focus.id,
    childUpdated.subfocus.id,
    { createdAt: LATER, revision: 2 },
    "second note",
    LAST,
  );
  assert.equal(noted.focus.revision, 1);
  assert.equal(noted.subfocus.revision, 3);
  assert.deepEqual(noted.subfocus.notes, ["first note", "second note"]);

  const path = findFocusPath(
    noted.catalog,
    created.focus.id,
    childCreated.subfocus.id,
  );
  assert.deepEqual(path, {
    focus: {
      kind: "focus",
      id: "focus-a",
      parentId: null,
      name: "Focus A",
      createdAt: NOW,
      updatedAt: NOW,
      revision: 1,
      goals: "parent goal",
      scope: "",
      constraints: "",
      planningDocs: [],
      refs: [],
      notes: [],
    },
    subfocus: {
      kind: "subfocus",
      id: "subfocus-a",
      parentId: "focus-a",
      name: "Subfocus A",
      createdAt: LATER,
      updatedAt: LAST,
      revision: 3,
      goals: "updated child goal",
      scope: "child scope",
      constraints: "child constraint",
      planningDocs: ["docs/child.md"],
      refs: ["DISC-1000"],
      notes: ["first note", "second note"],
      activation: { tools: ["bash"] },
    },
  });
  assert.equal(Object.isFrozen(path), true);
  assert.equal(Object.isFrozen(path.subfocus), true);
  assert.equal(summarizeFocusPath(path), [
    "Focus: Focus A",
    "Goals: parent goal",
    "Subfocus: Subfocus A",
    "Subfocus goals: updated child goal",
    "Subfocus scope: child scope",
    "Subfocus constraints: child constraint",
  ].join("\n"));
});

test("focus and subfocus IDs reserve suffix space within 200 characters", () => {
  const longName = "A".repeat(250);
  const first = createFocus(createEmptyCatalog(), { name: longName }, NOW);
  const second = createFocus(first.catalog, { name: longName }, LATER);
  assert.equal(first.focus.id, "a".repeat(200));
  assert.equal(second.focus.id, `${"a".repeat(198)}-2`);
  assert.equal(first.focus.id.length, 200);
  assert.equal(second.focus.id.length, 200);

  const firstChild = createSubfocus(second.catalog, first.focus.id, { name: longName }, LATEST);
  const secondChild = createSubfocus(firstChild.catalog, first.focus.id, { name: longName }, LAST);
  assert.equal(firstChild.subfocus.id, "a".repeat(200));
  assert.equal(secondChild.subfocus.id, `${"a".repeat(198)}-2`);
  assert.equal(firstChild.subfocus.id.length, 200);
  assert.equal(secondChild.subfocus.id.length, 200);
});
