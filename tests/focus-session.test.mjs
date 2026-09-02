import assert from "node:assert/strict";
import test from "node:test";

import {
  FOCUS_BINDING_CUSTOM_TYPE,
  MAX_TRANSFER_YAML_BYTES,
  SUBAGENT_BEFORE_CHILD_START,
  consumeInitialFocusTransfer,
  createFocusTransfer,
  createLocalFocusBinding,
  createTransferredFocusBinding,
  encodeFocusTransfer,
  focusBindingIds,
  normalizeFocusPathSnapshot,
  restoreFocusBinding,
} from "../extensions/focus-session.mjs";

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
  return {
    ...focus,
    kind: "subfocus",
    id: "subfocus-a",
    parentId,
    name: "Subfocus A",
  };
}

test("exports the binding contract and returns IDs only for active valid bindings", () => {
  assert.equal(FOCUS_BINDING_CUSTOM_TYPE, "pi-focus:binding");
  assert.equal(SUBAGENT_BEFORE_CHILD_START, "subagents:before-child-start");
  assert.deepEqual(focusBindingIds(binding), { focusId: "focus-a", subfocusId: null });
  assert.equal(focusBindingIds({ ...binding, active: null }), null);
  assert.equal(focusBindingIds({ ...binding, version: 2 }), null);
});

test("restores only the latest matching entry as a cloned frozen binding", () => {
  const latest = { ...binding, capturedAt: "2026-09-02T00:00:02.000Z" };
  const entries = [
    entry("entry-old", binding),
    { id: "unrelated", type: "custom", customType: "other", data: { version: 1 } },
    entry("entry-latest", latest),
  ];

  const restored = restoreFocusBinding(entries);

  assert.equal(restored.entryId, "entry-latest");
  assert.equal(restored.binding.capturedAt, latest.capturedAt);
  assert.notEqual(restored.binding, latest);
  assert.notEqual(restored.binding.active.focus, latest.active.focus);
  assert.equal(Object.isFrozen(restored.binding), true);
  assert.equal(Object.isFrozen(restored.binding.active.focus), true);
});

test("does not revive an older binding behind a malformed or unknown latest entry", () => {
  assert.equal(restoreFocusBinding([entry("valid", binding), entry("malformed", { nope: true })]), null);
  assert.equal(restoreFocusBinding([entry("valid", binding), entry("unknown", { ...binding, version: 2 })]), null);
});

test("restores explicit off state without reviving active or last", () => {
  const off = createLocalFocusBinding({
    agentSessionId: "session-a",
    capturedAt: "2026-09-02T00:00:02.000Z",
    active: null,
    last: binding.active,
  });
  const restored = restoreFocusBinding([entry("off", off)]).binding;

  assert.equal(restored.active, null);
  assert.equal(restored.last.focus.id, "focus-a");
  assert.equal(focusBindingIds(restored), null);
});

test("rejects impossible paths while preserving a valid nine-tool declaration", () => {
  const tools = Array.from({ length: 9 }, (_, index) => `tool-${index}`);
  const valid = normalizeFocusPathSnapshot({
    focus: { ...focus, activation: { tools } },
    subfocus: subfocus(),
  });

  assert.deepEqual(valid.focus.activation.tools, tools);
  assert.throws(
    () => normalizeFocusPathSnapshot({ focus: { ...focus, kind: "subfocus" }, subfocus: null }),
    /invalid focus path/i,
  );
  assert.throws(
    () => normalizeFocusPathSnapshot({ focus, subfocus: { ...subfocus(), kind: "focus" } }),
    /invalid focus path/i,
  );
  assert.throws(
    () => normalizeFocusPathSnapshot({ focus, subfocus: subfocus("different-parent") }),
    /invalid focus path/i,
  );
});

test("rejects per-field, list, and aggregate snapshot bounds", () => {
  assert.throws(
    () => normalizeFocusPathSnapshot({ focus: { ...focus, id: `a${"b".repeat(200)}` }, subfocus: null }),
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
    () => normalizeFocusPathSnapshot({ focus: { ...focus, goals: "x".repeat(501) }, subfocus: null }),
    /invalid focus path/i,
  );

  const maxFields = Array(8).fill("x".repeat(500));
  const oversizedPath = {
    focus: {
      ...focus,
      planningDocs: maxFields,
      refs: maxFields,
      notes: maxFields,
      activation: {
        tools: Array(128).fill("t".repeat(200)),
        monitors: maxFields,
        scripts: maxFields,
        agents: maxFields,
      },
    },
    subfocus: null,
  };
  assert.throws(() => normalizeFocusPathSnapshot(oversizedPath), /focus path.*large/i);
});

test("transfers parent provenance without last and derives the child last from active", () => {
  const parent = { entryId: "entry-a", binding: createLocalFocusBinding(binding) };
  const transfer = createFocusTransfer(parent, "parent-inherited", binding.active);

  assert.deepEqual(transfer.parent, { sessionId: "session-a", entryId: "entry-a" });
  assert.equal("last" in transfer, false);
  assert.equal("agentSessionId" in transfer, false);

  const child = createTransferredFocusBinding("session-child", transfer);
  assert.equal(child.agentSessionId, "session-child");
  assert.equal(child.source, "parent-inherited");
  assert.strictEqual(child.last, child.active);
  assert.equal(Object.isFrozen(child.active.focus), true);

  const offChild = createTransferredFocusBinding(
    "session-off-child",
    createFocusTransfer(parent, "parent-assigned", null),
  );
  assert.equal(offChild.active, null);
  assert.equal(offChild.last, null);
});

test("encodes and consumes exactly one initial transfer block at an eligible offset", () => {
  const transfer = createFocusTransfer({ entryId: "entry-a", binding }, "parent-inherited", binding.active);
  const block = encodeFocusTransfer(transfer);
  assert.match(block, /^<pi-focus-binding>\n/);
  assert.match(block, /\n<\/pi-focus-binding>\n$/);

  const direct = consumeInitialFocusTransfer(`${block}do the task`);
  assert.equal(direct.text, "do the task");
  assert.deepEqual(direct.transfer, transfer);

  const prefix = "---\n# Your Task (below)\n";
  const inherited = consumeInitialFocusTransfer(`${prefix}${block}do the task`);
  assert.equal(inherited.text, `${prefix}do the task`);
  assert.deepEqual(inherited.transfer, transfer);

  assert.equal(consumeInitialFocusTransfer(`context\n${block}do the task`), null);
  assert.throws(() => consumeInitialFocusTransfer(`${block}${block}do the task`), /multiple focus transfer blocks/i);

  const oversized = `<pi-focus-binding>\n${"x".repeat(MAX_TRANSFER_YAML_BYTES + 1)}\n</pi-focus-binding>\n`;
  assert.throws(() => consumeInitialFocusTransfer(oversized), /focus transfer.*large/i);
});
