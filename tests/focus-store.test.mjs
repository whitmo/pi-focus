import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs, { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

import {
  createEmptyCatalog,
  createFocus,
  createSubfocus,
  retireFocus,
  updateFocus,
} from "../extensions/focus-core.mjs";
import {
  deleteKnowledgeEntry,
  ensureContainerDirectories,
  focusDirectory,
  focusRoot,
  listKnowledgeEntries,
  loadFocusCatalog,
  readKnowledgeEntry,
  subfocusDirectory,
  updateFocusCatalog,
  writeKnowledgeEntry,
} from "../extensions/focus-store.mjs";

const NOW = "2026-09-02T00:00:00.000Z";
const LATER = "2026-09-02T01:00:00.000Z";
const EPOCH = "1970-01-01T00:00:00.000Z";

function project() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-focus-"));
  mkdirSync(join(cwd, ".agents"));
  return cwd;
}

function cleanup(cwd) {
  rmSync(cwd, { recursive: true, force: true });
}

function createCatalogFocus(cwd, input = { name: "Focus A" }) {
  return updateFocusCatalog(cwd, (catalog) => createFocus(catalog, input, NOW));
}

function legacyState(overrides = {}) {
  return JSON.stringify({
    activeFocusId: "ignored",
    lastFocusId: "ignored",
    retiredFocusIds: [],
    updatedAt: NOW,
    foci: [{
      id: "focus-a",
      name: "Focus A",
      goals: "ship",
      scope: "store",
      constraints: "safe",
      planningDocs: ["plan.md"],
      refs: ["ref"],
      notes: ["note"],
      activeSubfocusId: "ignored-subfocus",
      createdAt: NOW,
      updatedAt: NOW,
      subfocuses: [{
        id: "ignored-subfocus",
        name: "Subfocus",
        createdAt: NOW,
        updatedAt: NOW,
      }],
    }],
    ...overrides,
  }, null, 2);
}

function catalogLock(root, token = "stale") {
  const path = join(root, ".catalog.lock");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "owner.yaml"), [
    "pid: 999999",
    `token: ${token}`,
    `hostname: ${hostname()}`,
    "created_at: 0",
    "",
  ].join("\n"));
  return path;
}

test("stores a catalog as revisioned Markdown without state JSON", (t) => {
  const cwd = project();
  t.after(() => cleanup(cwd));

  let transition;
  const result = updateFocusCatalog(cwd, (catalog) => {
    transition = createFocus(catalog, { name: "Focus A" }, NOW);
    return transition;
  });
  const document = readFileSync(join(cwd, ".agents/focus/foci/focus-a/focus.md"), "utf8");

  assert.strictEqual(result, transition);
  assert.equal(result.focus.id, "focus-a");
  assert.match(document, /^---\n/);
  assert.match(document, /revision: 1/);
  assert.equal(document.endsWith("---\n"), true);
  assert.equal(existsSync(join(cwd, ".agents/focus/state.json")), false);
  assert.equal(loadFocusCatalog(cwd).foci[0].name, "Focus A");
  assert.ok(document.indexOf("id:") < document.indexOf("name:"));
  assert.ok(document.indexOf("created_at:") < document.indexOf("updated_at:"));
});

test("round-trips required focus and subfocus descriptor identity fields", (t) => {
  const cwd = project();
  t.after(() => cleanup(cwd));

  const created = createCatalogFocus(cwd);
  const transition = updateFocusCatalog(cwd, (catalog) => createSubfocus(
    catalog,
    created.focus.id,
    { name: "Subfocus A" },
    LATER,
  ));
  const focusPath = join(focusDirectory(cwd, created.focus.id), "focus.md");
  const subfocusPath = join(subfocusDirectory(cwd, created.focus.id, transition.subfocus.id), "subfocus.md");
  const focusDocument = readFileSync(focusPath, "utf8");
  const subfocusDocument = readFileSync(subfocusPath, "utf8");
  const focusFrontmatter = parse(focusDocument.match(/^---\n([\s\S]*?)\n---/)[1]);
  const subfocusFrontmatter = parse(subfocusDocument.match(/^---\n([\s\S]*?)\n---/)[1]);

  assert.deepEqual(
    { kind: focusFrontmatter.kind, parentId: focusFrontmatter.parent_id },
    { kind: "focus", parentId: null },
  );
  assert.deepEqual(
    { kind: subfocusFrontmatter.kind, parentId: subfocusFrontmatter.parent_id },
    { kind: "subfocus", parentId: created.focus.id },
  );
  assert.deepEqual(loadFocusCatalog(cwd), transition.catalog);

  for (const [path, document, from, to] of [
    [focusPath, focusDocument, "kind: focus\n", "kind: subfocus\n"],
    [focusPath, focusDocument, "parent_id: null\n", ""],
    [subfocusPath, subfocusDocument, "kind: subfocus\n", "kind: focus\n"],
    [subfocusPath, subfocusDocument, `parent_id: ${created.focus.id}\n`, ""],
  ]) {
    writeFileSync(path, document.replace(from, to));
    assert.throws(() => loadFocusCatalog(cwd), /invalid catalog descriptor/i);
    writeFileSync(path, document);
  }
});

test("preserves a Markdown body when an extension updates frontmatter", (t) => {
  const cwd = project();
  t.after(() => cleanup(cwd));

  const created = createCatalogFocus(cwd);
  const path = join(focusDirectory(cwd, created.focus.id), "focus.md");
  const original = readFileSync(path, "utf8");
  writeFileSync(path, `${original}# Design\nKeep this body verbatim.\n`);

  updateFocusCatalog(cwd, (catalog) => updateFocus(
    catalog,
    created.focus.id,
    { createdAt: NOW, revision: 1 },
    { goals: "new goal" },
    LATER,
  ));

  const updated = readFileSync(path, "utf8");
  assert.match(updated, /goals: new goal/);
  assert.equal(updated.slice(updated.indexOf("# Design")), "# Design\nKeep this body verbatim.\n");
});

test("keeps focus and subfocus knowledge entries in their own containers", (t) => {
  const cwd = project();
  t.after(() => cleanup(cwd));

  const created = createCatalogFocus(cwd);
  const subfocus = updateFocusCatalog(cwd, (catalog) => createSubfocus(
    catalog,
    created.focus.id,
    { name: "Subfocus A" },
    LATER,
  ));

  writeKnowledgeEntry(cwd, created.focus.id, "Plan", "focus");
  writeKnowledgeEntry(cwd, created.focus.id, "Plan", "subfocus", subfocus.subfocus.id);

  assert.equal(
    subfocusDirectory(cwd, created.focus.id, subfocus.subfocus.id),
    join(focusDirectory(cwd, created.focus.id), "subfocuses", subfocus.subfocus.id),
  );
  assert.equal(readKnowledgeEntry(cwd, created.focus.id, "Plan"), "focus");
  assert.equal(
    readKnowledgeEntry(cwd, created.focus.id, "Plan", subfocus.subfocus.id),
    "subfocus",
  );
  assert.deepEqual(listKnowledgeEntries(cwd, created.focus.id), ["plan"]);
  assert.deepEqual(
    listKnowledgeEntries(cwd, created.focus.id, subfocus.subfocus.id),
    ["plan"],
  );
  assert.equal(
    existsSync(join(subfocusDirectory(cwd, created.focus.id, subfocus.subfocus.id), "kb", "plan.md")),
    true,
  );
});

test("serializes catalog updates without losing concurrent documents", async (t) => {
  const cwd = project();
  t.after(() => cleanup(cwd));
  const moduleUrl = new URL("../extensions/focus-store.mjs", import.meta.url).href;
  const coreUrl = new URL("../extensions/focus-core.mjs", import.meta.url).href;
  const ready = join(cwd, "ready");

  const first = spawn(process.execPath, ["--input-type=module", "-e", `
    import { writeFileSync } from 'node:fs';
    import { createFocus } from ${JSON.stringify(coreUrl)};
    import { updateFocusCatalog } from ${JSON.stringify(moduleUrl)};
    const wait = new Int32Array(new SharedArrayBuffer(4));
    updateFocusCatalog(${JSON.stringify(cwd)}, (catalog) => {
      const result = createFocus(catalog, { name: 'First' }, ${JSON.stringify(NOW)});
      writeFileSync(${JSON.stringify(ready)}, 'ready');
      Atomics.wait(wait, 0, 0, 250);
      return result;
    });
  `]);
  await waitFor(ready);
  const second = spawn(process.execPath, ["--input-type=module", "-e", `
    import { createFocus } from ${JSON.stringify(coreUrl)};
    import { updateFocusCatalog } from ${JSON.stringify(moduleUrl)};
    updateFocusCatalog(${JSON.stringify(cwd)}, (catalog) =>
      createFocus(catalog, { name: 'Second' }, ${JSON.stringify(LATER)}),
    );
  `]);
  await Promise.all([exit(first), exit(second)]);

  assert.deepEqual(loadFocusCatalog(cwd).foci.map((focus) => focus.id), ["first", "second"]);
});

test("rejects stale catalog locks without entering update callbacks", async (t) => {
  const cwd = project();
  t.after(() => cleanup(cwd));
  const root = focusRoot(cwd);
  mkdirSync(root, { recursive: true });
  catalogLock(root);
  const moduleUrl = new URL("../extensions/focus-store.mjs", import.meta.url).href;

  const children = ["first", "second"].map((label) => spawn(process.execPath, ["--input-type=module", "-e", `
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { updateFocusCatalog } from ${JSON.stringify(moduleUrl)};
    try {
      updateFocusCatalog(${JSON.stringify(cwd)}, () => {
        writeFileSync(join(${JSON.stringify(cwd)}, 'callback-' + ${JSON.stringify(label)}), 'entered');
        return { catalog: { foci: [], retiredFocusIds: [] } };
      });
    } catch (error) {
      writeFileSync(join(${JSON.stringify(cwd)}, 'error-' + ${JSON.stringify(label)}), error.message);
    }
  `]));
  await Promise.all(children.map(exit));

  for (const label of ["first", "second"]) {
    assert.equal(existsSync(join(cwd, `callback-${label}`)), false);
    assert.match(readFileSync(join(cwd, `error-${label}`), "utf8"), /stale catalog lock detected/i);
  }
  assert.equal(existsSync(join(root, ".catalog.lock", "owner.yaml")), true);
  rmSync(join(root, ".catalog.lock"), { recursive: true });
});

test("releases a failed catalog update lock", (t) => {
  const cwd = project();
  t.after(() => cleanup(cwd));

  assert.throws(() => updateFocusCatalog(cwd, () => { throw new Error("stop"); }), /stop/);
  assert.equal(existsSync(join(focusRoot(cwd), ".catalog.lock")), false);
  assert.equal(createCatalogFocus(cwd).focus.id, "focus-a");
});

test("releases a failed migration lock and leaves a permanent YAML state sentinel", (t) => {
  const invalid = project();
  const migrated = project();
  t.after(() => cleanup(invalid));
  t.after(() => cleanup(migrated));

  const invalidRoot = focusRoot(invalid);
  mkdirSync(invalidRoot, { recursive: true });
  writeFileSync(join(invalidRoot, "state.json"), "not json");
  assert.throws(() => loadFocusCatalog(invalid), /invalid state JSON/i);
  assert.equal(existsSync(join(invalidRoot, ".catalog.lock")), false);
  assert.equal(existsSync(join(invalidRoot, ".state.lock")), false);

  const root = focusRoot(migrated);
  mkdirSync(root, { recursive: true });
  const source = legacyState();
  writeFileSync(join(root, "state.json"), source);
  assert.equal(loadFocusCatalog(migrated).foci[0].id, "focus-a");
  assert.deepEqual(parse(readFileSync(join(root, ".state.lock"), "utf8")), { migrated: true });
  writeFileSync(join(root, "state.json"), "not json");
  assert.equal(loadFocusCatalog(migrated).foci[0].id, "focus-a");
});

test("retains the legacy lock if its YAML sentinel write fails after marker creation", (t) => {
  const cwd = project();
  t.after(() => cleanup(cwd));
  const root = focusRoot(cwd);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "state.json"), legacyState());
  const sentinel = join(root, ".state.lock");
  const originalRename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (destination === sentinel) {
      const error = new Error("sentinel write denied");
      error.code = "EACCES";
      throw error;
    }
    return originalRename(source, destination);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  });

  assert.throws(() => loadFocusCatalog(cwd), /sentinel write denied/);
  assert.equal(existsSync(join(root, ".catalog-v1.yaml")), true);
  assert.equal(existsSync(sentinel), true);
  assert.match(readFileSync(sentinel, "utf8"), /"token"/);
  assert.throws(() => writeFileSync(sentinel, "v0.1 writer", { flag: "wx" }), { code: "EEXIST" });
  writeFileSync(join(root, "state.json"), "not json");
  assert.equal(loadFocusCatalog(cwd).foci[0].id, "focus-a");
});

test("writes a complete migration marker after descriptor verification", (t) => {
  const cwd = project();
  t.after(() => cleanup(cwd));
  const root = focusRoot(cwd);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "state.json"), legacyState());

  assert.equal(loadFocusCatalog(cwd).foci[0].subfocuses.length, 1);
  assert.equal(
    existsSync(join(root, "foci", "focus-a", "subfocuses", "ignored-subfocus", "subfocus.md")),
    true,
  );
  assert.equal(
    existsSync(join(root, "foci", "focus-a", "subfoci", "ignored-subfocus", "subfocus.md")),
    false,
  );
  const marker = parse(readFileSync(join(root, ".catalog-v1.yaml"), "utf8"));

  assert.deepEqual(Object.keys(marker).sort(), [
    "completed_at",
    "record_count",
    "source_sha256",
    "version",
  ]);
  assert.equal(marker.version, 1);
  assert.match(marker.source_sha256, /^[a-f0-9]{64}$/);
  assert.equal(marker.record_count, 2);
  assert.equal(new Date(marker.completed_at).toISOString(), marker.completed_at);
});

test("keeps the migration marker count aligned after catalog updates", (t) => {
  const cwd = project();
  t.after(() => cleanup(cwd));
  const root = focusRoot(cwd);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "state.json"), legacyState());

  loadFocusCatalog(cwd);
  updateFocusCatalog(cwd, (catalog) => createFocus(catalog, { name: "Second" }, LATER));

  assert.equal(loadFocusCatalog(cwd).foci.length, 2);
  assert.equal(parse(readFileSync(join(root, ".catalog-v1.yaml"), "utf8")).record_count, 3);
});

test("rejects incomplete and mismatched migration markers", (t) => {
  const cwd = project();
  t.after(() => cleanup(cwd));
  const root = focusRoot(cwd);
  createCatalogFocus(cwd);
  const marker = join(root, ".catalog-v1.yaml");

  writeFileSync(marker, "version: 1\n");
  assert.throws(() => loadFocusCatalog(cwd), /migration marker/i);
  writeFileSync(marker, [
    "version: 1",
    `source_sha256: ${"a".repeat(64)}`,
    "record_count: 2",
    `completed_at: ${NOW}`,
    "",
  ].join("\n"));
  assert.throws(() => loadFocusCatalog(cwd), /record count/i);
});

test("migrates legacy records without carrying selection and backfills timestamps", (t) => {
  const timestamped = project();
  const epoch = project();
  t.after(() => cleanup(timestamped));
  t.after(() => cleanup(epoch));

  const timestampedRoot = focusRoot(timestamped);
  mkdirSync(timestampedRoot, { recursive: true });
  writeFileSync(timestampedRoot + "/state.json", legacyState({
    foci: [{
      id: "focus-a",
      name: "Focus A",
      activeSubfocusId: "ignored-subfocus",
      createdAt: null,
      updatedAt: null,
      subfocuses: [{ id: "ignored-subfocus", name: "Subfocus", createdAt: null, updatedAt: null }],
    }],
  }));
  const migrated = loadFocusCatalog(timestamped);
  assert.equal("activeFocusId" in migrated, false);
  assert.equal("lastFocusId" in migrated, false);
  assert.equal("activeSubfocusId" in migrated.foci[0], false);
  assert.equal(migrated.foci[0].createdAt, NOW);
  assert.equal(migrated.foci[0].updatedAt, NOW);
  assert.equal(migrated.foci[0].subfocuses[0].createdAt, NOW);

  const epochRoot = focusRoot(epoch);
  mkdirSync(epochRoot, { recursive: true });
  writeFileSync(epochRoot + "/state.json", legacyState({
    updatedAt: null,
    foci: [{ id: "focus-a", name: "Focus A", createdAt: null, updatedAt: null, subfocuses: [] }],
  }));
  const epochCatalog = loadFocusCatalog(epoch);
  assert.equal(epochCatalog.foci[0].createdAt, EPOCH);
  assert.equal(epochCatalog.foci[0].updatedAt, EPOCH);
});

test("retries partial migration by replacing only stale descriptors", (t) => {
  const cwd = project();
  t.after(() => cleanup(cwd));
  const root = focusRoot(cwd);
  mkdirSync(root, { recursive: true });
  const stale = ensureContainerDirectories(cwd, "stale");
  const staleSubfocus = ensureContainerDirectories(cwd, "stale", "old");
  writeFileSync(join(stale.focus, "focus.md"), "---\nid: stale\n---\nstale\n");
  writeFileSync(join(stale.focus, "retired.yaml"), "id: stale\n");
  writeFileSync(join(staleSubfocus.subfocus, "subfocus.md"), "---\nid: old\n---\nstale\n");
  writeFileSync(join(stale.kb, "keep.md"), "keep");
  writeFileSync(join(stale.state, "keep"), "keep");
  writeFileSync(join(staleSubfocus.kb, "keep.md"), "keep");
  writeFileSync(join(root, "state.json"), legacyState());

  const catalog = loadFocusCatalog(cwd);

  assert.deepEqual(catalog.foci.map((focus) => focus.id), ["focus-a"]);
  assert.equal(existsSync(join(stale.focus, "focus.md")), false);
  assert.equal(existsSync(join(stale.focus, "retired.yaml")), false);
  assert.equal(existsSync(join(staleSubfocus.subfocus, "subfocus.md")), false);
  assert.equal(readFileSync(join(stale.kb, "keep.md"), "utf8"), "keep");
  assert.equal(readFileSync(join(stale.state, "keep"), "utf8"), "keep");
  assert.equal(readFileSync(join(staleSubfocus.kb, "keep.md"), "utf8"), "keep");
  assert.equal(existsSync(join(root, ".catalog-v1.yaml")), true);
});

test("retires in place, preserves container data, and rejects ID reuse", (t) => {
  const cwd = project();
  t.after(() => cleanup(cwd));

  const created = createCatalogFocus(cwd, { name: "Alpha" });
  const paths = ensureContainerDirectories(cwd, created.focus.id);
  writeKnowledgeEntry(cwd, created.focus.id, "Plan", "keep");
  writeFileSync(join(paths.state, "local"), "keep");
  updateFocusCatalog(cwd, (catalog) => retireFocus(
    catalog,
    created.focus.id,
    { createdAt: NOW, revision: 1 },
  ));

  assert.equal(existsSync(join(paths.focus, "focus.md")), false);
  assert.equal(existsSync(join(paths.focus, "retired.yaml")), true);
  assert.equal(readKnowledgeEntry(cwd, created.focus.id, "Plan"), "keep");
  assert.equal(readFileSync(join(paths.state, "local"), "utf8"), "keep");
  const next = updateFocusCatalog(cwd, (catalog) => createFocus(catalog, { name: "Alpha" }, LATER));
  assert.equal(next.focus.id, "alpha-2");
});

test("KB writes and deletes share the retirement lock", async (t) => {
  const cwd = project();
  t.after(() => cleanup(cwd));
  const created = createCatalogFocus(cwd, { name: "Alpha" });
  writeKnowledgeEntry(cwd, created.focus.id, "Plan", "present");
  const ready = join(cwd, "ready");
  const moduleUrl = new URL("../extensions/focus-store.mjs", import.meta.url).href;
  const coreUrl = new URL("../extensions/focus-core.mjs", import.meta.url).href;

  const retiring = spawn(process.execPath, ["--input-type=module", "-e", `
    import { writeFileSync } from 'node:fs';
    import { retireFocus } from ${JSON.stringify(coreUrl)};
    import { updateFocusCatalog } from ${JSON.stringify(moduleUrl)};
    const wait = new Int32Array(new SharedArrayBuffer(4));
    updateFocusCatalog(${JSON.stringify(cwd)}, (catalog) => {
      const focus = catalog.foci[0];
      const result = retireFocus(catalog, focus.id, { createdAt: focus.createdAt, revision: focus.revision });
      writeFileSync(${JSON.stringify(ready)}, 'ready');
      Atomics.wait(wait, 0, 0, 250);
      return result;
    });
  `]);
  await waitFor(ready);

  assert.throws(
    () => writeKnowledgeEntry(cwd, created.focus.id, "Plan", "blocked"),
    /retired or missing/i,
  );
  assert.throws(
    () => deleteKnowledgeEntry(cwd, created.focus.id, "Plan"),
    /retired or missing/i,
  );
  await exit(retiring);
  assert.equal(readKnowledgeEntry(cwd, created.focus.id, "Plan"), "present");
});

test("uses atomic descriptor and knowledge replacement without temporary files", (t) => {
  const cwd = project();
  t.after(() => cleanup(cwd));

  const created = createCatalogFocus(cwd, { name: "Alpha", activation: { tools: ["never-persist-as-command"] } });
  writeKnowledgeEntry(cwd, created.focus.id, "Release Notes", "# First\n");
  writeKnowledgeEntry(cwd, created.focus.id, "Release Notes", "# Final\n");

  const document = readFileSync(join(focusDirectory(cwd, created.focus.id), "focus.md"), "utf8");
  assert.match(document, /tools:/);
  assert.equal(readKnowledgeEntry(cwd, created.focus.id, "Release Notes"), "# Final\n");
  assert.equal(temporaryFiles(focusRoot(cwd)).length, 0);
});

test("keeps knowledge paths contained and rejects traversal or symlinks", (t) => {
  const cwd = project();
  const outside = mkdtempSync(join(tmpdir(), "pi-focus-outside-"));
  t.after(() => cleanup(cwd));
  t.after(() => cleanup(outside));
  const created = createCatalogFocus(cwd, { name: "Alpha" });

  writeKnowledgeEntry(cwd, created.focus.id, "A useful note!", "ok");
  assert.equal(existsSync(join(focusDirectory(cwd, created.focus.id), "kb", "a-useful-note.md")), true);
  for (const name of ["", ".", "..", "../outside", "sub/entry", "sub\\entry", "/outside", "\0bad"]) {
    assert.throws(() => writeKnowledgeEntry(cwd, created.focus.id, name, "no"), /knowledge entry name/i);
  }
  assert.throws(() => ensureContainerDirectories(cwd, "../escape"), /focus ID/i);
  assert.throws(() => ensureContainerDirectories(cwd, "a".repeat(201)), /focus ID/i);

  const paths = ensureContainerDirectories(cwd, created.focus.id);
  rmSync(paths.kb, { recursive: true });
  symlinkSync(outside, paths.kb);
  assert.throws(() => writeKnowledgeEntry(cwd, created.focus.id, "plan", "no"), /symlink/i);

  rmSync(paths.kb);
  mkdirSync(paths.kb);
  symlinkSync(join(outside, "secret.md"), join(paths.kb, "outside.md"));
  assert.throws(() => listKnowledgeEntries(cwd, created.focus.id), /symlink/i);
  assert.throws(() => readKnowledgeEntry(cwd, created.focus.id, "outside"), /symlink/i);
  assert.equal(lstatSync(join(paths.kb, "outside.md")).isSymbolicLink(), true);

  const parentSymlink = project();
  t.after(() => cleanup(parentSymlink));
  const parentRoot = focusRoot(parentSymlink);
  mkdirSync(parentRoot, { recursive: true });
  symlinkSync(outside, join(parentRoot, "foci"));
  assert.throws(() => listKnowledgeEntries(parentSymlink, "alpha"), /symlink/i);
});

test("rejects tagged YAML descriptor input", (t) => {
  const cwd = project();
  t.after(() => cleanup(cwd));
  const root = focusRoot(cwd);
  const paths = ensureContainerDirectories(cwd, "alpha");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, ".catalog-v1.yaml"), [
    "version: 1",
    `source_sha256: ${"a".repeat(64)}`,
    "record_count: 1",
    `completed_at: ${NOW}`,
    "",
  ].join("\n"));
  writeFileSync(join(paths.focus, "focus.md"), [
    "---",
    "id: alpha",
    "name: Alpha",
    "goals: !!js/function >",
    "  function () {}",
    "scope: ''",
    "constraints: ''",
    "planning_docs: []",
    "refs: []",
    "notes: []",
    `created_at: ${NOW}`,
    `updated_at: ${NOW}`,
    "revision: 1",
    "---",
    "",
  ].join("\n"));

  assert.throws(() => loadFocusCatalog(cwd), /YAML|catalog schema/i);
});

test("does not maintain legacy JSON after migration", (t) => {
  const cwd = project();
  t.after(() => cleanup(cwd));
  const root = focusRoot(cwd);
  mkdirSync(root, { recursive: true });
  const source = legacyState();
  writeFileSync(join(root, "state.json"), source);

  const migrated = loadFocusCatalog(cwd);
  updateFocusCatalog(cwd, (catalog) => createFocus(catalog, { name: "Second" }, LATER));

  assert.equal(readFileSync(join(root, "state.json"), "utf8"), source);
  assert.equal(migrated.foci[0].id, "focus-a");
  assert.equal(existsSync(join(root, ".catalog-v1.yaml")), true);
});

function temporaryFiles(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) return temporaryFiles(entryPath);
    return entry.name.includes(".tmp") ? [entryPath] : [];
  });
}

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
