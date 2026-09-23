import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import { createFocus, createSubfocus } from "../extensions/focus-core.mjs";
import { FOCUS_BINDING_CUSTOM_TYPE, restoreFocusBinding } from "../extensions/focus-session.mjs";
import { updateFocusCatalog } from "../extensions/focus-store.mjs";

const EXTENSION = fileURLToPath(new URL("../extensions/index.ts", import.meta.url));
const NOW = "2026-09-02T00:00:00.000Z";

async function boot(cwd, agentDir) {
  const eventBus = createEventBus();
  const sessionManager = SessionManager.inMemory(cwd);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    eventBus,
    additionalExtensionPaths: [EXTENSION],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    resourceLoader: loader,
    sessionManager,
    tools: ["read", "bash"],
  });
  await session.bindExtensions({});
  return { eventBus, session, sessionManager };
}

function request(eventBus, selector) {
  let acknowledgement;
  eventBus.emit("pi-focus:bind-child", {
    ...selector,
    acknowledge(result) { acknowledgement = result; },
  });
  return acknowledgement;
}

test("real loader and session persist child focus before context or tool guards", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "focus-child-integration-"));
  const agentDir = mkdtempSync(join(tmpdir(), "focus-child-agent-"));
  t.after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });
  const parent = updateFocusCatalog(cwd, (catalog) => createFocus(catalog, {
    name: "Child launch",
    goals: "bind before work",
    activation: { tools: ["read"] },
  }, NOW));
  const child = updateFocusCatalog(cwd, (catalog) => createSubfocus(catalog, parent.focus.id, {
    name: "Adapter",
    goals: "exercise the real loader",
  }, NOW));
  const runtime = await boot(cwd, agentDir);
  t.after(() => runtime.session.dispose());
  const activeTools = runtime.session.getActiveToolNames();

  assert.deepEqual(request(runtime.eventBus, {
    focusId: parent.focus.id,
    subfocusId: child.subfocus.id,
  }), { ok: true });

  const restored = restoreFocusBinding(runtime.sessionManager.getBranch());
  assert.equal(restored.binding.active.focus.id, parent.focus.id);
  assert.equal(restored.binding.active.subfocus.id, child.subfocus.id);
  assert.equal(restored.binding.source, "local");
  assert.equal(Object.isFrozen(restored.binding.active), true);
  assert.equal(
    runtime.sessionManager.getBranch().at(-1).customType,
    FOCUS_BINDING_CUSTOM_TYPE,
  );

  const context = await runtime.session.extensionRunner.emitContext([]);
  assert.deepEqual(context, []);
  const beforeStart = await runtime.session.extensionRunner.emitBeforeAgentStart(
    "child request",
    undefined,
    "base system prompt",
    {},
  );
  assert.match(beforeStart.systemPrompt, /Focus: Child launch/);
  assert.match(beforeStart.systemPrompt, /Subfocus: Adapter/);
  const blocked = await runtime.session.extensionRunner.emitToolCall({
    type: "tool_call",
    toolCallId: "tool-1",
    toolName: "bash",
    input: { command: "pwd" },
  });
  assert.match(blocked.reason, /not declared/);
  assert.deepEqual(runtime.session.getActiveToolNames(), activeTools);
});
