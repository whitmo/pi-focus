import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDocument as parseYamlDocument, stringify } from "yaml";

import {
  createEmptyCatalog,
  normalizeFocusCatalog,
  normalizeLegacyFocusState,
} from "./focus-core.mjs";

const LOCK_RETRIES = 100;
const LOCK_RETRY_MS = 20;
const STALE_LOCK_MS = 30_000;
const EPOCH = "1970-01-01T00:00:00.000Z";
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/;

export function focusRoot(cwd) {
  return join(projectRoot(cwd), ".agents", "focus");
}

export function focusDirectory(cwd, focusId) {
  return join(focusRoot(cwd), "foci", validateFocusId(focusId));
}

export function subfocusDirectory(cwd, focusId, subfocusId) {
  return join(
    focusDirectory(cwd, focusId),
    "subfocuses",
    validateFocusId(subfocusId),
  );
}

export function ensureContainerDirectories(cwd, focusId, subfocusId = null) {
  const root = ensureFocusRoot(cwd);
  const foci = ensureDirectory(join(root, "foci"));
  const focus = ensureDirectory(join(foci, validateFocusId(focusId)));
  const container = subfocusId === null
    ? focus
    : ensureDirectory(join(
      ensureDirectory(join(focus, "subfocuses")),
      validateFocusId(subfocusId),
    ));

  return {
    focus,
    ...(subfocusId === null ? {} : { subfocus: container }),
    kb: ensureDirectory(join(container, "kb")),
    state: ensureDirectory(join(container, "state")),
  };
}

export function loadFocusCatalog(cwd) {
  return withCatalogLock(cwd, (root) => loadCatalogUnlocked(cwd, root));
}

export function updateFocusCatalog(cwd, update) {
  if (typeof update !== "function") {
    throw new Error("focus: catalog update must be a function");
  }

  return withCatalogLock(cwd, (root) => {
    const current = loadCatalogUnlocked(cwd, root);
    const result = update(current);
    if (!isRecord(result) || result.catalog === undefined) {
      throw new Error("focus: catalog update must return a catalog result");
    }

    const next = normalizeFocusCatalog(result.catalog);
    persistCatalog(root, current, next);
    return result;
  });
}

export function listKnowledgeEntries(cwd, focusId, subfocusId = null) {
  const { kb, container } = existingContainerPaths(cwd, focusId, subfocusId);
  assertKnowledgeDirectoryIsSafe(kb, container);
  return readdirSync(kb, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name.slice(0, -3))
    .sort();
}

export function readKnowledgeEntry(cwd, focusId, name, subfocusId = null) {
  const path = knowledgePath(cwd, focusId, name, subfocusId);
  if (!pathExists(path)) {
    throw new Error(`focus: knowledge entry not found: ${name}`);
  }
  assertNotSymlink(path);
  return readFileSync(path, "utf8");
}

export function writeKnowledgeEntry(cwd, focusId, name, content, subfocusId = null) {
  if (typeof content !== "string") {
    throw new Error("focus: knowledge entry content must be a string");
  }

  return withCatalogLock(cwd, (root) => {
    const catalog = loadCatalogUnlocked(cwd, root);
    assertWritableContainer(catalog, focusId, subfocusId);
    ensureContainerDirectories(cwd, focusId, subfocusId);
    atomicWrite(knowledgePath(cwd, focusId, name, subfocusId), content);
  });
}

export function deleteKnowledgeEntry(cwd, focusId, name, subfocusId = null) {
  return withCatalogLock(cwd, (root) => {
    const catalog = loadCatalogUnlocked(cwd, root);
    assertWritableContainer(catalog, focusId, subfocusId);
    ensureContainerDirectories(cwd, focusId, subfocusId);
    const path = knowledgePath(cwd, focusId, name, subfocusId);
    if (!pathExists(path)) return false;
    assertNotSymlink(path);
    rmSync(path);
    return true;
  });
}

function loadCatalogUnlocked(cwd, root) {
  const marker = join(root, ".catalog-v1.yaml");
  if (pathExists(marker)) {
    const catalog = loadCatalogFromDescriptors(root);
    validateMigrationMarker(marker, catalog);
    return catalog;
  }

  const legacy = join(root, "state.json");
  if (pathExists(legacy)) {
    migrateLegacyCatalog(cwd, root, legacy);
  }
  return loadCatalogFromDescriptors(root);
}

function migrateLegacyCatalog(cwd, root, legacyPath) {
  const token = lockToken();
  const legacyLock = acquireLegacyStateLock(root, token);
  let markerWritten = false;
  let complete = false;

  try {
    assertNotSymlink(legacyPath);
    const source = readFileSync(legacyPath);
    const sourceHash = digest(source);
    const legacy = parseLegacyState(source.toString("utf8"));
    const catalog = legacyCatalog(legacy);
    preflightCatalog(catalog);

    removeAllDescriptors(root);
    persistCatalog(root, createEmptyCatalog(), catalog);
    const restored = loadCatalogFromDescriptors(root);
    if (JSON.stringify(canonicalCatalog(restored)) !== JSON.stringify(canonicalCatalog(catalog))) {
      throw new Error("focus: migrated catalog verification failed");
    }
    if (digest(readFileSync(legacyPath)) !== sourceHash) {
      throw new Error("focus: legacy state changed during migration");
    }

    atomicWrite(join(root, ".catalog-v1.yaml"), stringify({
      version: 1,
      source_sha256: sourceHash,
      record_count: descriptorRecordCount(restored),
      completed_at: new Date().toISOString(),
    }));
    markerWritten = true;
    atomicWrite(legacyLock.path, stringify({ migrated: true }));
    complete = true;
  } finally {
    if (!complete && !markerWritten) releaseLegacyStateLock(legacyLock);
  }
}

function parseLegacyState(source) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`focus: invalid state JSON: ${error.message}`);
  }

  try {
    return normalizeLegacyFocusState(parsed);
  } catch (error) {
    throw new Error(`focus: invalid state schema: ${error.message}`);
  }
}

function legacyCatalog(legacy) {
  const catalogTimestamp = legacy.updatedAt ?? EPOCH;
  return normalizeFocusCatalog({
    foci: legacy.foci.map((focus) => ({
      id: focus.id,
      name: focus.name,
      goals: focus.goals,
      scope: focus.scope,
      constraints: focus.constraints,
      planningDocs: focus.planningDocs,
      refs: focus.refs,
      notes: focus.notes,
      activation: focus.activation,
      createdAt: legacyTimestamp(focus.createdAt, catalogTimestamp),
      updatedAt: legacyTimestamp(focus.updatedAt, catalogTimestamp),
      revision: 1,
      subfocuses: focus.subfocuses.map((subfocus) => ({
        id: subfocus.id,
        parentId: focus.id,
        name: subfocus.name,
        goals: subfocus.goals,
        scope: subfocus.scope,
        constraints: subfocus.constraints,
        planningDocs: subfocus.planningDocs,
        refs: subfocus.refs,
        notes: subfocus.notes,
        activation: subfocus.activation,
        createdAt: legacyTimestamp(subfocus.createdAt, catalogTimestamp),
        updatedAt: legacyTimestamp(subfocus.updatedAt, catalogTimestamp),
        revision: 1,
      })),
    })),
    retiredFocusIds: legacy.retiredFocusIds,
  });
}

function legacyTimestamp(value, catalogTimestamp) {
  return value ?? catalogTimestamp ?? EPOCH;
}

function preflightCatalog(catalog) {
  const ids = new Set(catalog.retiredFocusIds);
  for (const focus of catalog.foci) {
    if (ids.has(focus.id)) {
      throw new Error("focus: legacy catalog reuses a retired focus ID");
    }
    if (ids.has(`focus:${focus.id}`)) {
      throw new Error("focus: duplicate legacy focus ID");
    }
    ids.add(`focus:${focus.id}`);

    const subfocusIds = new Set();
    for (const subfocus of focus.subfocuses) {
      if (subfocusIds.has(subfocus.id)) {
        throw new Error("focus: duplicate legacy subfocus ID");
      }
      subfocusIds.add(subfocus.id);
    }
  }
}

function persistCatalog(root, previous, next) {
  const before = normalizeFocusCatalog(previous);
  const after = normalizeFocusCatalog(next);
  const beforeFoci = new Map(before.foci.map((focus) => [focus.id, focus]));
  const afterFoci = new Map(after.foci.map((focus) => [focus.id, focus]));
  const beforeRetired = new Set(before.retiredFocusIds);
  const afterRetired = new Set(after.retiredFocusIds);

  for (const id of beforeRetired) {
    if (!afterRetired.has(id)) {
      throw new Error("focus: retired focus IDs cannot be reused");
    }
  }
  for (const id of afterRetired) {
    if (afterFoci.has(id)) {
      throw new Error("focus: active and retired focus IDs conflict");
    }
  }

  for (const [id, focus] of beforeFoci) {
    if (!afterFoci.has(id)) removeFocusDescriptors(root, focus);
  }

  for (const focus of after.foci) {
    if (afterRetired.has(focus.id)) {
      throw new Error("focus: active and retired focus IDs conflict");
    }
    const previousFocus = beforeFoci.get(focus.id);
    if (!previousFocus || !sameFocusDescriptor(previousFocus, focus)) {
      writeFocusDescriptor(root, focus);
    }
    persistSubfocusDescriptors(root, previousFocus?.subfocuses ?? [], focus);
  }

  for (const id of after.retiredFocusIds) {
    if (!beforeRetired.has(id)) writeRetirementDescriptor(root, id);
  }
  refreshMigrationMarker(root, after);
}

function refreshMigrationMarker(root, catalog) {
  const path = join(root, ".catalog-v1.yaml");
  if (!pathExists(path)) return;
  const marker = parseYamlFile(path, "migration marker");
  atomicWrite(path, stringify({
    ...marker,
    record_count: descriptorRecordCount(catalog),
    completed_at: new Date().toISOString(),
  }));
}

function persistSubfocusDescriptors(root, before, focus) {
  const previous = new Map(before.map((subfocus) => [subfocus.id, subfocus]));
  const next = new Map(focus.subfocuses.map((subfocus) => [subfocus.id, subfocus]));

  for (const [id] of previous) {
    if (!next.has(id)) removeSubfocusDescriptor(root, focus.id, id);
  }
  for (const subfocus of focus.subfocuses) {
    if (!previous.has(subfocus.id) || !sameRecord(previous.get(subfocus.id), subfocus)) {
      writeSubfocusDescriptor(root, focus.id, subfocus);
    }
  }
}

function removeFocusDescriptors(root, focus) {
  removeDescriptor(join(root, "foci", focus.id, "focus.md"));
  for (const subfocus of focus.subfocuses) {
    removeSubfocusDescriptor(root, focus.id, subfocus.id);
  }
}

function removeSubfocusDescriptor(root, focusId, subfocusId) {
  removeDescriptor(join(root, "foci", focusId, "subfocuses", subfocusId, "subfocus.md"));
}

function removeAllDescriptors(root) {
  for (const descriptor of descriptorEntries(root)) {
    removeDescriptor(descriptor.focus);
    removeDescriptor(descriptor.retired);
    for (const subfocus of descriptor.subfocuses) removeDescriptor(subfocus.document);
  }
}

function removeDescriptor(path) {
  if (!pathExists(path)) return;
  assertNotSymlink(path);
  unlinkSync(path);
}

function writeFocusDescriptor(root, focus) {
  const paths = ensureContainerDirectories(root, focus.id);
  const path = join(paths.focus, "focus.md");
  atomicWrite(path, encodeDocument(encodeFocus(focus), documentBody(path)));
}

function writeSubfocusDescriptor(root, focusId, subfocus) {
  const paths = ensureContainerDirectories(root, focusId, subfocus.id);
  const path = join(paths.subfocus, "subfocus.md");
  atomicWrite(path, encodeDocument(encodeSubfocus(subfocus), documentBody(path)));
}

function writeRetirementDescriptor(root, focusId) {
  const paths = ensureContainerDirectories(root, focusId);
  atomicWrite(join(paths.focus, "retired.yaml"), stringify({ id: focusId }));
}

function documentBody(path) {
  if (!pathExists(path)) return "";
  assertNotSymlink(path);
  return parseDocument(readFileSync(path, "utf8"), path).body;
}

function loadCatalogFromDescriptors(root) {
  const foci = [];
  const retiredFocusIds = [];

  for (const descriptor of descriptorEntries(root)) {
    if (descriptor.focus && descriptor.retired) {
      throw new Error(`focus: conflicting descriptors for ${descriptor.id}`);
    }
    if (descriptor.retired) {
      const retirement = parseYamlFile(descriptor.retired, "retirement descriptor");
      if (!isRecord(retirement) || retirement.id !== descriptor.id) {
        throw new Error("focus: invalid retirement descriptor");
      }
      retiredFocusIds.push(descriptor.id);
      continue;
    }
    if (!descriptor.focus) continue;

    const focus = decodeFocus(parseDocument(readFileSync(descriptor.focus, "utf8"), descriptor.focus).frontmatter);
    if (focus.id !== descriptor.id) {
      throw new Error("focus: descriptor ID does not match its directory");
    }
    const subfocuses = descriptor.subfocuses
      .filter((subfocus) => subfocus.document)
      .map((subfocus) => {
        const record = decodeSubfocus(
          parseDocument(readFileSync(subfocus.document, "utf8"), subfocus.document).frontmatter,
        );
        if (record.id !== subfocus.id || record.parentId !== focus.id) {
          throw new Error("focus: subfocus descriptor does not match its directory");
        }
        return record;
      })
      .sort(byId);
    foci.push({ ...focus, subfocuses });
  }

  return normalizeFocusCatalog({
    foci: foci.sort(byId),
    retiredFocusIds: retiredFocusIds.sort(),
  });
}

function descriptorEntries(root) {
  const foci = join(root, "foci");
  if (!pathExists(foci)) return [];
  assertDirectory(foci);

  return readdirSync(foci, { withFileTypes: true })
    .map((entry) => {
      if (entry.isSymbolicLink()) {
        throw new Error("focus: symlinked path is not allowed");
      }
      if (!entry.isDirectory() || !validFocusId(entry.name)) return null;
      const directory = join(foci, entry.name);
      assertDirectory(directory);
      const subfocuses = join(directory, "subfocuses");
      return {
        id: entry.name,
        focus: descriptorFile(join(directory, "focus.md")),
        retired: descriptorFile(join(directory, "retired.yaml")),
        subfocuses: pathExists(subfocuses) ? subfocusDescriptorEntries(subfocuses) : [],
      };
    })
    .filter(Boolean)
    .sort(byId);
}

function subfocusDescriptorEntries(path) {
  assertDirectory(path);
  return readdirSync(path, { withFileTypes: true })
    .map((entry) => {
      if (entry.isSymbolicLink()) {
        throw new Error("focus: symlinked path is not allowed");
      }
      if (!entry.isDirectory() || !validFocusId(entry.name)) return null;
      const directory = join(path, entry.name);
      assertDirectory(directory);
      return {
        id: entry.name,
        document: descriptorFile(join(directory, "subfocus.md")),
      };
    })
    .filter(Boolean)
    .sort(byId);
}

function descriptorFile(path) {
  const info = lstatIfExists(path);
  if (!info) return null;
  if (info.isSymbolicLink()) {
    throw new Error(`focus: symlinked path is not allowed: ${path}`);
  }
  if (!info.isFile()) throw new Error(`focus: expected descriptor file: ${path}`);
  return path;
}

function encodeDocument(frontmatter, body) {
  return `---\n${stringify(frontmatter)}---\n${body}`;
}

function parseDocument(document, path) {
  const match = document.match(FRONTMATTER);
  if (!match) throw new Error(`focus: invalid frontmatter: ${path}`);

  let frontmatter;
  try {
    frontmatter = parseYaml(match[1]);
  } catch (error) {
    throw new Error(`focus: invalid YAML document: ${error.message}`);
  }
  if (!isRecord(frontmatter)) throw new Error(`focus: invalid YAML document: ${path}`);
  return { frontmatter, body: match[2] ?? "" };
}

function encodeFocus(focus) {
  return {
    kind: "focus",
    parent_id: null,
    ...descriptorFields(focus),
  };
}

function encodeSubfocus(subfocus) {
  return {
    kind: "subfocus",
    parent_id: subfocus.parentId,
    ...descriptorFields(subfocus),
  };
}

function descriptorFields(record, omitted = []) {
  const fields = {
    id: record.id,
    name: record.name,
    goals: record.goals,
    scope: record.scope,
    constraints: record.constraints,
    planning_docs: record.planningDocs,
    refs: record.refs,
    notes: record.notes,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    revision: record.revision,
  };
  if (record.activation !== undefined) fields.activation = encodeActivation(record.activation);
  return Object.fromEntries(Object.entries(fields).filter(([key]) => !omitted.includes(key)));
}

function encodeActivation(activation) {
  return {
    ...(activation.tools === undefined ? {} : { tools: activation.tools }),
    ...(activation.loadoutPreset === undefined ? {} : { loadout_preset: activation.loadoutPreset }),
    ...(activation.monitors === undefined ? {} : { monitors: activation.monitors }),
    ...(activation.scripts === undefined ? {} : { scripts: activation.scripts }),
    ...(activation.agents === undefined ? {} : { agents: activation.agents }),
  };
}

function decodeFocus(frontmatter) {
  return decodeDescriptor(frontmatter, false);
}

function decodeSubfocus(frontmatter) {
  return decodeDescriptor(frontmatter, true);
}

function decodeDescriptor(frontmatter, subfocus) {
  if (
    frontmatter.kind !== (subfocus ? "subfocus" : "focus")
    || (subfocus ? typeof frontmatter.parent_id !== "string" : frontmatter.parent_id !== null)
  ) {
    throw new Error("focus: invalid catalog descriptor identity");
  }
  const record = {
    id: frontmatter.id,
    ...(subfocus ? { parentId: frontmatter.parent_id } : {}),
    name: frontmatter.name,
    goals: frontmatter.goals,
    scope: frontmatter.scope,
    constraints: frontmatter.constraints,
    planningDocs: frontmatter.planning_docs,
    refs: frontmatter.refs,
    notes: frontmatter.notes,
    activation: decodeActivation(frontmatter.activation),
    createdAt: frontmatter.created_at,
    updatedAt: frontmatter.updated_at,
    revision: frontmatter.revision,
  };

  try {
    const catalog = normalizeFocusCatalog({
      foci: subfocus
        ? [{
          id: record.parentId,
          name: "Parent",
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          revision: 1,
          subfocuses: [record],
        }]
        : [{ ...record, subfocuses: [] }],
      retiredFocusIds: [],
    });
    return subfocus ? catalog.foci[0].subfocuses[0] : catalog.foci[0];
  } catch (error) {
    throw new Error(`focus: invalid catalog descriptor: ${error.message}`);
  }
}

function decodeActivation(value) {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return value;
  return {
    ...(value.tools === undefined ? {} : { tools: value.tools }),
    ...(value.loadout_preset === undefined ? {} : { loadoutPreset: value.loadout_preset }),
    ...(value.monitors === undefined ? {} : { monitors: value.monitors }),
    ...(value.scripts === undefined ? {} : { scripts: value.scripts }),
    ...(value.agents === undefined ? {} : { agents: value.agents }),
  };
}

function validateMigrationMarker(path, catalog) {
  const marker = parseYamlFile(path, "migration marker");
  if (!isRecord(marker) || marker.version !== 1) {
    throw new Error("focus: invalid catalog migration marker");
  }
  if (typeof marker.source_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(marker.source_sha256)) {
    throw new Error("focus: invalid catalog migration marker source SHA-256");
  }
  if (!Number.isInteger(marker.record_count) || marker.record_count !== descriptorRecordCount(catalog)) {
    throw new Error("focus: invalid catalog migration marker record count");
  }
  if (!validIsoTimestamp(marker.completed_at)) {
    throw new Error("focus: invalid catalog migration marker completion timestamp");
  }
}

function descriptorRecordCount(catalog) {
  return catalog.foci.reduce((count, focus) => count + 1 + focus.subfocuses.length, 0);
}

function validIsoTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function parseYamlFile(path, label) {
  assertNotSymlink(path);
  try {
    return parseYaml(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`focus: invalid ${label}: ${error.message}`);
  }
}

function parseYaml(source) {
  const document = parseYamlDocument(source, { prettyErrors: false });
  if (document.errors.length || document.warnings.length) {
    throw document.errors[0] ?? document.warnings[0];
  }
  return document.toJS();
}

function assertWritableContainer(catalog, focusId, subfocusId) {
  const id = validateFocusId(focusId);
  if (catalog.retiredFocusIds.includes(id)) {
    throw new Error("focus: knowledge container is retired or missing");
  }
  const focus = catalog.foci.find((item) => item.id === id);
  if (!focus) throw new Error("focus: knowledge container is retired or missing");
  if (subfocusId !== null && !focus.subfocuses.some((item) => item.id === validateFocusId(subfocusId))) {
    throw new Error("focus: knowledge container is retired or missing");
  }
}

function existingContainerPaths(cwd, focusId, subfocusId) {
  const root = focusRoot(cwd);
  const foci = join(root, "foci");
  assertDirectory(root);
  assertDirectory(foci);
  const focus = focusDirectory(cwd, focusId);
  assertDirectory(focus);
  const container = subfocusId === null
    ? focus
    : subfocusDirectory(cwd, focusId, subfocusId);
  if (subfocusId !== null) assertDirectory(join(focus, "subfocuses"));
  assertDirectory(container);
  assertWithin(realpathSync(focus), realpathSync(container));
  return { focus, container, kb: join(container, "kb") };
}

function knowledgePath(cwd, focusId, name, subfocusId) {
  const { container, kb } = existingContainerPaths(cwd, focusId, subfocusId);
  assertKnowledgeDirectoryIsSafe(kb, container);
  const path = join(realpathSync(kb), knowledgeFileName(name));
  assertWithin(realpathSync(container), path);
  if (pathExists(path)) assertNotSymlink(path);
  return path;
}

function knowledgeFileName(name) {
  if (
    typeof name !== "string"
    || !name.trim()
    || name.includes("\0")
    || isAbsolute(name)
    || /[\\/]/.test(name)
    || name === "."
    || name === ".."
  ) {
    throw new Error("focus: invalid knowledge entry name");
  }
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) throw new Error("focus: invalid knowledge entry name");
  return `${slug}.md`;
}

function sameFocusDescriptor(left, right) {
  const { subfocuses: leftSubfocuses, ...leftDescriptor } = left;
  const { subfocuses: rightSubfocuses, ...rightDescriptor } = right;
  return sameRecord(leftDescriptor, rightDescriptor);
}

function sameRecord(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalCatalog(catalog) {
  const normalized = normalizeFocusCatalog(catalog);
  return {
    foci: normalized.foci
      .map((focus) => ({
        ...focus,
        subfocuses: [...focus.subfocuses].sort(byId),
      }))
      .sort(byId),
    retiredFocusIds: [...normalized.retiredFocusIds].sort(),
  };
}

function projectRoot(cwd) {
  let current = resolve(cwd || process.cwd());
  for (;;) {
    if (pathExists(join(current, ".agents")) || pathExists(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(cwd || process.cwd());
    current = parent;
  }
}

function ensureFocusRoot(cwd) {
  const project = projectRoot(cwd);
  const agents = ensureDirectory(join(project, ".agents"));
  return ensureDirectory(join(agents, "focus"));
}

function assertKnowledgeDirectoryIsSafe(kb, container) {
  assertDirectory(kb);
  assertWithin(realpathSync(container), realpathSync(kb));
  for (const entry of readdirSync(kb, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error("focus: symlinked knowledge entry is not allowed");
    }
  }
}

function ensureDirectory(path) {
  if (!pathExists(path)) {
    try {
      mkdirSync(path);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  assertDirectory(path);
  return path;
}

function assertDirectory(path) {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new Error(`focus: symlinked path is not allowed: ${path}`);
  if (!info.isDirectory()) throw new Error(`focus: expected directory: ${path}`);
}

function assertNotSymlink(path) {
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error(`focus: symlinked path is not allowed: ${path}`);
  }
}

function assertWithin(parent, path) {
  const resolvedParent = resolve(parent);
  const resolvedPath = resolve(path);
  const distance = relative(resolvedParent, resolvedPath);
  if (distance === "" || (!distance.startsWith(`..${sep}`) && distance !== ".." && !isAbsolute(distance))) return;
  throw new Error("focus: path escapes focus directory");
}

function validateFocusId(value) {
  if (!validFocusId(value)) throw new Error("focus: invalid focus ID");
  return value;
}

function validFocusId(value) {
  return typeof value === "string"
    && value.length <= 200
    && /^[a-z0-9][a-z0-9-]*$/.test(value);
}

function pathExists(path) {
  return lstatIfExists(path) !== null;
}

function lstatIfExists(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function atomicWrite(path, content) {
  if (pathExists(path)) assertNotSymlink(path);
  const temp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    writeFileSync(temp, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    if (pathExists(temp)) rmSync(temp, { force: true });
  }
}

function withCatalogLock(cwd, operation) {
  const root = ensureFocusRoot(cwd);
  const lock = acquireCatalogLock(root, lockToken());
  try {
    return operation(root);
  } finally {
    releaseCatalogLock(lock);
  }
}

function acquireCatalogLock(root, token) {
  const path = join(root, ".catalog.lock");
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      mkdirSync(path, { mode: 0o700 });
      try {
        writeFileSync(join(path, "owner.yaml"), stringify({
          pid: process.pid,
          token,
          hostname: hostname(),
          created_at: Date.now(),
        }), { encoding: "utf8", flag: "wx", mode: 0o600 });
      } catch (error) {
        rmSync(path, { recursive: true, force: true });
        throw error;
      }
      return { path, token };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      reportStaleCatalogLock(path);
      sleep(LOCK_RETRY_MS);
    }
  }
  throw new Error("focus: catalog lock is held; try again");
}

function reportStaleCatalogLock(path) {
  try {
    assertDirectory(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  const owner = join(path, "owner.yaml");
  if (!pathExists(owner)) return;
  const lock = parseLock(owner, "catalog lock");
  if (isStaleLocalLock(lock)) {
    throw new Error("focus: stale catalog lock detected; remove it after confirming no updater is running");
  }
}

function releaseCatalogLock(lock) {
  if (!pathExists(lock.path)) return;
  try {
    assertDirectory(lock.path);
    const owner = join(lock.path, "owner.yaml");
    if (pathExists(owner) && parseLock(owner, "catalog lock").token === lock.token) {
      rmSync(lock.path, { recursive: true, force: true });
    }
  } catch {
    // A corrupt lock is not ours to remove.
  }
}

function acquireLegacyStateLock(root, token) {
  const path = join(root, ".state.lock");
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      const descriptor = openSync(path, "wx", 0o600);
      try {
        writeFileSync(descriptor, JSON.stringify({
          pid: process.pid,
          token,
          hostname: hostname(),
          createdAt: Date.now(),
        }));
      } finally {
        closeSync(descriptor);
      }
      return { path, token };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      reportStaleLegacyStateLock(path);
      sleep(LOCK_RETRY_MS);
    }
  }
  throw new Error("focus: state lock is held; try again");
}

function reportStaleLegacyStateLock(path) {
  try {
    assertNotSymlink(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  let lock;
  try {
    lock = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    return;
  }
  if (isStaleLocalLock(lock)) {
    throw new Error("focus: stale state lock detected; remove it after confirming no updater is running");
  }
}

function releaseLegacyStateLock(lock) {
  if (!pathExists(lock.path)) return;
  try {
    assertNotSymlink(lock.path);
    const descriptor = JSON.parse(readFileSync(lock.path, "utf8"));
    if (descriptor.token === lock.token) unlinkSync(lock.path);
  } catch {
    // A corrupt lock is not ours to remove.
  }
}

function parseLock(path, label) {
  try {
    return parseYamlFile(path, label);
  } catch {
    return null;
  }
}

function isStaleLocalLock(lock) {
  return isRecord(lock)
    && lock.hostname === hostname()
    && Number.isInteger(lock.pid)
    && typeof (lock.created_at ?? lock.createdAt) === "number"
    && Date.now() - (lock.created_at ?? lock.createdAt) >= STALE_LOCK_MS
    && !processIsAlive(lock.pid);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function lockToken() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function byId(left, right) {
  return left.id.localeCompare(right.id);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
