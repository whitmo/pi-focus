import assert from "node:assert/strict";
import test from "node:test";

import * as focusSession from "../extensions/focus-session.mjs";

const {
  FOCUS_BINDING_CUSTOM_TYPE,
  createForkedFocusBinding,
  createLocalFocusBinding,
  focusBindingIds,
  normalizeFocusPathSnapshot,
  restoreFocusBinding,
} = focusSession;

const focus = {
  kind: "focus",
  id: "focus-a",
  parentId: null,
  name: "Focus A",
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  revision: 1,
  goals: "ship",
  scope: "focus",
  constraints: "safe",
  planningDocs: [],
  refs: [],
  notes: [],
};
const binding = {
  version: 1,
  agentSessionId: "session-a",
  capturedAt: "2026-09-02T00:00:01.000Z",
  source: "local",
  active: { focus, subfocus: null },
  last: { focus, subfocus: null },
};

function entry(id, data) {
  return { id, type: "custom", customType: FOCUS_BINDING_CUSTOM_TYPE, data };
}

function subfocus(parentId = focus.id) {
  return { ...focus, kind: "subfocus", id: "subfocus-a", parentId, name: "Subfocus A" };
}

test("exports only the standalone session-binding API", () => {
  assert.deepEqual(Object.keys(focusSession).sort(), [
    "FOCUS_BINDING_CUSTOM_TYPE",
    "createForkedFocusBinding",
    "createLocalFocusBinding",
    "focusBindingIds",
    "normalizeFocusPathSnapshot",
    "restoreFocusBinding",
  ]);
  assert.equal(FOCUS_BINDING_CUSTOM_TYPE, "pi-focus:binding");
});

test("restores only the latest binding and preserves explicit off", () => {
  const latest = { ...binding, capturedAt: "2026-09-02T00:00:02.000Z" };
  const restored = restoreFocusBinding([
    entry("entry-old", binding),
    { id: "unrelated", type: "custom", customType: "other", data: {} },
    entry("entry-latest", latest),
  ]);

  assert.equal(restored.entryId, "entry-latest");
  assert.equal(restored.binding.capturedAt, latest.capturedAt);
  assert.notEqual(restored.binding, latest);
  assert.notEqual(restored.binding.active.focus, latest.active.focus);
  assert.equal(Object.isFrozen(restored.binding.active.focus), true);
  assert.equal(restoreFocusBinding([entry("valid", binding), entry("bad", { version: 2 })]), null);

  const off = createLocalFocusBinding({
    agentSessionId: "session-a",
    capturedAt: "2026-09-02T00:00:03.000Z",
    active: null,
    last: binding.active,
  });
  assert.equal(restoreFocusBinding([entry("off", off)]).binding.active, null);
  assert.equal(focusBindingIds(off), null);
  assert.deepEqual(focusBindingIds(binding), { focusId: "focus-a", subfocusId: null });
});

test("creates local and fork bindings without parent-transfer sources", () => {
  const local = createLocalFocusBinding(binding);
  assert.equal(local.source, "local");
  assert.equal("forkedFrom" in local, false);

  const forked = createForkedFocusBinding("session-child", { entryId: "entry-a", binding: local });
  assert.equal(forked.agentSessionId, "session-child");
  assert.equal(forked.source, "fork");
  assert.deepEqual(forked.forkedFrom, { sessionId: "session-a", entryId: "entry-a" });
  assert.equal(forked.active.focus.id, "focus-a");
  assert.equal(Object.isFrozen(forked.last.focus), true);
  assert.equal(focusBindingIds({ ...binding, source: "parent-inherited" }), null);
});

test("validates bounded immutable focus paths", () => {
  const tools = Array.from({ length: 9 }, (_, index) => `tool-${index}`);
  const valid = normalizeFocusPathSnapshot({
    focus: { ...focus, activation: { tools } },
    subfocus: subfocus(),
  });
  assert.deepEqual(valid.focus.activation.tools, tools);
  assert.equal(Object.isFrozen(valid), true);

  assert.throws(
    () => normalizeFocusPathSnapshot({ focus: { ...focus, id: `a${"b".repeat(200)}` }, subfocus: null }),
    /invalid focus path/i,
  );
  assert.throws(
    () => normalizeFocusPathSnapshot({ focus: { ...focus, goals: "x".repeat(501) }, subfocus: null }),
    /invalid focus path/i,
  );
  assert.throws(
    () => normalizeFocusPathSnapshot({
      focus: { ...focus, activation: { tools: Array.from({ length: 129 }, (_, index) => `tool-${index}`) } },
      subfocus: null,
    }),
    /invalid focus path/i,
  );
  assert.throws(
    () => normalizeFocusPathSnapshot({ focus, subfocus: subfocus("other-focus") }),
    /invalid focus path/i,
  );

  const maxFields = Array(8).fill("x".repeat(500));
  assert.throws(
    () => normalizeFocusPathSnapshot({
      focus: {
        ...focus,
        planningDocs: maxFields,
        refs: maxFields,
        notes: maxFields,
        activation: { tools: Array(128).fill("t".repeat(200)) },
      },
      subfocus: null,
    }),
    /focus path.*large/i,
  );
});
