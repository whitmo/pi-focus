import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createEmptyState, createFocus, deleteFocus } from "../extensions/focus-core.mjs";
import {
  deleteKnowledgeEntry,
  ensureFocusDirectories,
  focusDirectory,
  focusRoot,
  listKnowledgeEntries,
  loadFocusState,
  readKnowledgeEntry,
  removeFocusDirectory,
  saveFocusState,
  updateFocusState,
  writeKnowledgeEntry,
} from "../extensions/focus-store.mjs";

function project() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-focus-"));
  mkdirSync(join(cwd, ".agents"));
  return cwd;
}

function cleanup(cwd) {
  rmSync(cwd, { recursive: true, force: true });
}

test("creates isolated focus directories beneath each project root", (t) => {
  const first = project();
  const second = project();
  t.after(() => cleanup(first));
  t.after(() => cleanup(second));

  const firstPaths = ensureFocusDirectories(first, "alpha");
  const siblingPaths = ensureFocusDirectories(first, "beta");
  const secondPaths = ensureFocusDirectories(second, "alpha");

  assert.equal(firstPaths.focus, focusDirectory(first, "alpha"));
  assert.notEqual(focusRoot(first), focusRoot(second));
  assert.notEqual(firstPaths.focus, siblingPaths.focus);
  assert.notEqual(firstPaths.focus, secondPaths.focus);
  assert.equal(existsSync(firstPaths.kb), true);
  assert.equal(existsSync(firstPaths.state), true);
  assert.equal(existsSync(secondPaths.kb), true);
  assert.equal(existsSync(secondPaths.state), true);
});

test("loads legacy state without rewriting it and rejects invalid state", (t) => {
  const cwd = project();
  t.after(() => cleanup(cwd));
  const root = focusRoot(cwd);
  mkdirSync(root, { recursive: true });
  const legacy = '{\n  "foci": [{ "id": "legacy", "name": "Legacy" }]\n}\n';
  writeFileSync(join(root, "state.json"), legacy);

  assert.equal(loadFocusState(cwd).foci[0].name, "Legacy");
  assert.equal(readFileSync(join(root, "state.json"), "utf8"), legacy);
  writeFileSync(join(root, "state.json"), "not json");
  assert.throws(() => loadFocusState(cwd), /invalid state JSON/i);
  writeFileSync(join(root, "state.json"), '{"foci": {}}');
  assert.throws(() => loadFocusState(cwd), /invalid state schema/i);
});

test("serializes concurrent state updates without losing either change", async (t) => {
  const cwd = project();
  t.after(() => cleanup(cwd));
  const moduleUrl = new URL("../extensions/focus-store.mjs", import.meta.url).href;
  const ready = join(cwd, "ready");
  saveFocusState(cwd, { ...createEmptyState(), foci: [{ id: "one", name: "One" }] });

  const first = spawn(process.execPath, ["--input-type=module", "-e", `
    import { writeFileSync } from 'node:fs';
    import { updateFocusState } from ${JSON.stringify(moduleUrl)};
    const wait = new Int32Array(new SharedArrayBuffer(4));
    updateFocusState(${JSON.stringify(cwd)}, (state) => {
      writeFileSync(${JSON.stringify(ready)}, 'ready');
      Atomics.wait(wait, 0, 0, 250);
      return { ...state, lastFocusId: 'one' };
    });
  `]);
  await waitFor(ready);
  const second = spawn(process.execPath, ["--input-type=module", "-e", `
    import { updateFocusState } from ${JSON.stringify(moduleUrl)};
    updateFocusState(${JSON.stringify(cwd)}, (state) => ({ ...state, activeFocusId: 'one' }));
  `]);
  await Promise.all([exit(first), exit(second)]);

  const state = loadFocusState(cwd);
  assert.equal(state.activeFocusId, "one");
  assert.equal(state.lastFocusId, "one");
});

test("releases a failed update lock and reports stale dead local locks", (t) => {
  const cwd = project();
  t.after(() => cleanup(cwd));
  const root = focusRoot(cwd);

  assert.throws(() => updateFocusState(cwd, () => { throw new Error("stop"); }), /stop/);
  updateFocusState(cwd, (current) => ({ ...current, activeFocusId: "one" }));
  assert.equal(loadFocusState(cwd).activeFocusId, "one");

  writeFileSync(join(root, ".state.lock"), JSON.stringify({ pid: 999999, token: "stale", hostname: hostname(), createdAt: 0 }));
  assert.throws(() => updateFocusState(cwd, (current) => ({ ...current, lastFocusId: "one" })), /stale state lock detected/i);
  rmSync(join(root, ".state.lock"));
  updateFocusState(cwd, (current) => ({ ...current, lastFocusId: "one" }));
  assert.equal(loadFocusState(cwd).lastFocusId, "one");

  writeFileSync(join(root, ".state.lock"), JSON.stringify({ pid: 999999, token: "foreign", hostname: "another-host", createdAt: 0 }));
  assert.throws(() => updateFocusState(cwd, (current) => current), /state lock is held/i);
  rmSync(join(root, ".state.lock"));
  writeFileSync(join(root, ".state.lock"), JSON.stringify({ pid: 999999, token: "hostless", createdAt: 0 }));
  assert.throws(() => updateFocusState(cwd, (current) => current), /state lock is held/i);
  rmSync(join(root, ".state.lock"));
});

test("competing stale-lock reclaimers never enter callbacks", async (t) => {
  const cwd = project();
  t.after(() => cleanup(cwd));
  const root = focusRoot(cwd);
  const moduleUrl = new URL("../extensions/focus-store.mjs", import.meta.url).href;
  const original = { pid: 999999, token: "original-stale-lock", hostname: hostname(), createdAt: 0 };
  saveFocusState(cwd, { ...createEmptyState(), foci: [{ id: "one", name: "One" }] });
  writeFileSync(join(root, ".state.lock"), JSON.stringify(original));

  const children = ["first", "second"].map((label) => spawn(process.execPath, ["--input-type=module", "-e", `
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { updateFocusState } from ${JSON.stringify(moduleUrl)};
    try {
      updateFocusState(${JSON.stringify(cwd)}, (state) => {
        writeFileSync(join(${JSON.stringify(cwd)}, 'callback-' + ${JSON.stringify(label)}), 'entered');
        return { ...state, activeFocusId: 'one' };
      });
    } catch (error) {
      writeFileSync(join(${JSON.stringify(cwd)}, 'error-' + ${JSON.stringify(label)}), error.message);
    }
  `]));
  await Promise.all(children.map(exit));

  for (const label of ["first", "second"]) {
    assert.equal(existsSync(join(cwd, `callback-${label}`)), false);
    assert.match(readFileSync(join(cwd, `error-${label}`), "utf8"), /stale state lock detected/i);
  }
  assert.deepEqual(loadFocusState(cwd), { ...createEmptyState(), foci: [{ id: "one", name: "One", goals: "", scope: "", constraints: "", planningDocs: [], refs: [], notes: [], subfocuses: [], activeSubfocusId: null, createdAt: null, updatedAt: null }] });
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".state.lock"), "utf8")), original);
  rmSync(join(root, ".state.lock"));
});

test("uses atomic state and knowledge-entry replacement without temporary files", (t) => {
  const cwd = project();
  t.after(() => cleanup(cwd));
  const root = focusRoot(cwd);
  const paths = ensureFocusDirectories(cwd, "alpha");

  saveFocusState(cwd, createFocus(createEmptyState(), { name: "Alpha", command: "never-persist" }));
  assert.equal("command" in JSON.parse(readFileSync(join(root, "state.json"), "utf8")).foci[0], false);
  writeKnowledgeEntry(cwd, "alpha", "Release Notes", "# First\n");
  writeKnowledgeEntry(cwd, "alpha", "Release Notes", "# Final\n");

  assert.doesNotThrow(() => JSON.parse(readFileSync(join(root, "state.json"), "utf8")));
  assert.equal(readKnowledgeEntry(cwd, "alpha", "Release Notes"), "# Final\n");
  assert.equal(readdirSync(root).some((name) => name.includes(".tmp")), false);
  assert.equal(readdirSync(paths.kb).some((name) => name.includes(".tmp")), false);
});

test("keeps knowledge operations inside the active focus KB", (t) => {
  const cwd = project();
  t.after(() => cleanup(cwd));
  ensureFocusDirectories(cwd, "alpha");
  ensureFocusDirectories(cwd, "beta");

  writeKnowledgeEntry(cwd, "alpha", "Plan", "alpha");
  writeKnowledgeEntry(cwd, "beta", "Plan", "beta");

  assert.deepEqual(listKnowledgeEntries(cwd, "alpha"), ["plan"]);
  assert.equal(readKnowledgeEntry(cwd, "alpha", "Plan"), "alpha");
  writeKnowledgeEntry(cwd, "alpha", "Plan", "updated");
  deleteKnowledgeEntry(cwd, "alpha", "Plan");
  assert.deepEqual(listKnowledgeEntries(cwd, "alpha"), []);
  assert.equal(readKnowledgeEntry(cwd, "beta", "Plan"), "beta");
});

test("makes safe Markdown entry names and rejects path traversal", (t) => {
  const cwd = project();
  t.after(() => cleanup(cwd));
  ensureFocusDirectories(cwd, "alpha");
  writeKnowledgeEntry(cwd, "alpha", "A useful note!", "ok");

  assert.equal(existsSync(join(focusDirectory(cwd, "alpha"), "kb", "a-useful-note.md")), true);
  for (const name of ["", ".", "..", "../outside", "sub/entry", "sub\\entry", "/outside", "\0bad"]) {
    assert.throws(() => writeKnowledgeEntry(cwd, "alpha", name, "no"), /knowledge entry name/i);
  }
  assert.throws(() => ensureFocusDirectories(cwd, "../escape"), /focus ID/i);
});

test("rejects symlinked focus, KB, and KB-entry components", (t) => {
  const cwd = project();
  const outside = mkdtempSync(join(tmpdir(), "pi-focus-outside-"));
  t.after(() => cleanup(cwd));
  t.after(() => cleanup(outside));
  const root = focusRoot(cwd);
  mkdirSync(join(root, "foci"), { recursive: true });
  symlinkSync(outside, join(root, "foci", "linked-focus"));
  assert.throws(() => listKnowledgeEntries(cwd, "linked-focus"), /symlink/i);

  const paths = ensureFocusDirectories(cwd, "alpha");
  rmSync(paths.kb, { recursive: true });
  symlinkSync(outside, paths.kb);
  assert.throws(() => writeKnowledgeEntry(cwd, "alpha", "plan", "no"), /symlink/i);

  rmSync(paths.kb);
  mkdirSync(paths.kb);
  symlinkSync(join(outside, "secret.md"), join(paths.kb, "outside.md"));
  assert.throws(() => listKnowledgeEntries(cwd, "alpha"), /symlink/i);
  assert.throws(() => readKnowledgeEntry(cwd, "alpha", "outside"), /symlink/i);
  assert.equal(lstatSync(join(paths.kb, "outside.md")).isSymbolicLink(), true);
});

test("removes only the selected focus directory and clears matching IDs", (t) => {
  const cwd = project();
  t.after(() => cleanup(cwd));
  ensureFocusDirectories(cwd, "one");
  ensureFocusDirectories(cwd, "two");
  saveFocusState(cwd, {
    activeFocusId: "one",
    lastFocusId: "two",
    foci: [{ id: "one", name: "One" }, { id: "two", name: "Two" }],
    updatedAt: null,
  });

  updateFocusState(cwd, (state) => deleteFocus(state, "one", "2026-08-28T00:00:00.000Z"));
  removeFocusDirectory(cwd, "one");

  assert.equal(existsSync(focusDirectory(cwd, "one")), false);
  assert.equal(existsSync(focusDirectory(cwd, "two")), true);
  assert.deepEqual(loadFocusState(cwd).foci.map((focus) => focus.id), ["two"]);
  assert.equal(loadFocusState(cwd).activeFocusId, null);
  assert.equal(loadFocusState(cwd).lastFocusId, "two");
});

async function waitFor(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function exit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)));
  });
}
