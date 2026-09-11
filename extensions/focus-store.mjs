import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { createEmptyState, normalizeFocusState } from "./focus-core.mjs";

const LOCK_RETRIES = 100;
const LOCK_RETRY_MS = 20;
const STALE_LOCK_MS = 30_000;

export function focusRoot(cwd) {
  return join(projectRoot(cwd), ".agents", "focus");
}

export function focusDirectory(cwd, focusId) {
  return join(focusRoot(cwd), "foci", validateFocusId(focusId));
}

export function ensureFocusDirectories(cwd, focusId) {
  const root = ensureFocusRoot(cwd);
  const foci = ensureDirectory(join(root, "foci"));
  const focus = ensureDirectory(join(foci, validateFocusId(focusId)));
  return {
    focus,
    kb: ensureDirectory(join(focus, "kb")),
    state: ensureDirectory(join(focus, "state")),
  };
}

export function loadFocusState(cwd) {
  const path = statePath(cwd);
  assertExistingFocusRootIsSafe(cwd);
  if (!existsSync(path)) return createEmptyState();
  assertNotSymlink(path);

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`focus: invalid state JSON: ${error.message}`);
  }

  try {
    return normalizeFocusState(parsed);
  } catch (error) {
    throw new Error(`focus: invalid state schema: ${error.message}`);
  }
}

export function saveFocusState(cwd, state) {
  withStateLock(cwd, () => writeStateUnlocked(cwd, state));
}

export function updateFocusState(cwd, update) {
  if (typeof update !== "function") throw new Error("focus: state update must be a function");
  return withStateLock(cwd, () => {
    const state = loadFocusState(cwd);
    const next = update(state);
    return writeStateUnlocked(cwd, next);
  });
}

export function listKnowledgeEntries(cwd, focusId) {
  const { kb } = ensureFocusDirectories(cwd, focusId);
  assertKnowledgeDirectoryIsSafe(kb, focusDirectory(cwd, focusId));
  return readdirSync(kb, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name.slice(0, -3))
    .sort();
}

export function readKnowledgeEntry(cwd, focusId, name) {
  const path = knowledgePath(cwd, focusId, name);
  if (!existsSync(path)) throw new Error(`focus: knowledge entry not found: ${name}`);
  assertNotSymlink(path);
  return readFileSync(path, "utf8");
}

export function writeKnowledgeEntry(cwd, focusId, name, content) {
  if (typeof content !== "string") throw new Error("focus: knowledge entry content must be a string");
  const path = knowledgePath(cwd, focusId, name);
  atomicWrite(path, content);
}

export function deleteKnowledgeEntry(cwd, focusId, name) {
  const path = knowledgePath(cwd, focusId, name);
  if (!existsSync(path)) return false;
  assertNotSymlink(path);
  rmSync(path);
  return true;
}

export function removeFocusDirectory(cwd, focusId) {
  const root = ensureFocusRoot(cwd);
  const foci = ensureDirectory(join(root, "foci"));
  const path = join(foci, validateFocusId(focusId));
  if (!existsSync(path)) return false;
  assertNotSymlink(path);
  rmSync(path, { recursive: true, force: true });
  return true;
}

function writeStateUnlocked(cwd, state) {
  const root = ensureFocusRoot(cwd);
  const normalized = normalizeFocusState(state);
  atomicWrite(join(root, "state.json"), `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

function knowledgePath(cwd, focusId, name) {
  const { focus, kb } = ensureFocusDirectories(cwd, focusId);
  assertKnowledgeDirectoryIsSafe(kb, focus);
  const path = join(realpathSync(kb), knowledgeFileName(name));
  assertWithin(realpathSync(focus), path);
  if (existsSync(path)) assertNotSymlink(path);
  return path;
}

function knowledgeFileName(name) {
  if (typeof name !== "string" || !name.trim() || name.includes("\0") || isAbsolute(name) || /[\\/]/.test(name) || name === "." || name === "..") {
    throw new Error("focus: invalid knowledge entry name");
  }
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) throw new Error("focus: invalid knowledge entry name");
  return `${slug}.md`;
}

function statePath(cwd) {
  return join(focusRoot(cwd), "state.json");
}

function projectRoot(cwd) {
  let current = resolve(cwd || process.cwd());
  for (;;) {
    if (existsSync(join(current, ".agents")) || existsSync(join(current, ".git"))) return current;
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

function assertExistingFocusRootIsSafe(cwd) {
  const project = projectRoot(cwd);
  const agents = join(project, ".agents");
  const root = focusRoot(cwd);
  if (existsSync(agents)) assertDirectory(agents);
  if (existsSync(root)) assertDirectory(root);
}

function assertKnowledgeDirectoryIsSafe(kb, focus) {
  assertDirectory(kb);
  assertWithin(realpathSync(focus), realpathSync(kb));
  for (const entry of readdirSync(kb, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("focus: symlinked knowledge entry is not allowed");
  }
}

function ensureDirectory(path) {
  if (!existsSync(path)) {
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
  if (lstatSync(path).isSymbolicLink()) throw new Error(`focus: symlinked path is not allowed: ${path}`);
}

function assertWithin(parent, path) {
  const resolvedParent = resolve(parent);
  const resolvedPath = resolve(path);
  const distance = relative(resolvedParent, resolvedPath);
  if (distance === "" || (!distance.startsWith(`..${sep}`) && distance !== ".." && !isAbsolute(distance))) return;
  throw new Error("focus: path escapes focus directory");
}

function validateFocusId(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new Error("focus: invalid focus ID");
  }
  return value;
}

function atomicWrite(path, content) {
  if (existsSync(path)) assertNotSymlink(path);
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    writeFileSync(temp, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
}

function withStateLock(cwd, operation) {
  const root = ensureFocusRoot(cwd);
  const path = join(root, ".state.lock");
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  acquireLock(path, token);
  try {
    return operation();
  } finally {
    releaseLock(path, token);
  }
}

function acquireLock(path, token) {
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      const descriptor = openSync(path, "wx", 0o600);
      try {
        writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, hostname: hostname(), createdAt: Date.now() }));
      } finally {
        closeSync(descriptor);
      }
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      reportStaleLock(path);
      sleep(LOCK_RETRY_MS);
    }
  }
  throw new Error("focus: state lock is held; try again");
}

function reportStaleLock(path) {
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
  if (lock.hostname === hostname() && Number.isInteger(lock.pid) && typeof lock.createdAt === "number" && Date.now() - lock.createdAt >= STALE_LOCK_MS && !processIsAlive(lock.pid)) {
    throw new Error("focus: stale state lock detected; remove it after confirming no updater is running");
  }
}

function releaseLock(path, token) {
  if (!existsSync(path)) return;
  try {
    const lock = JSON.parse(readFileSync(path, "utf8"));
    if (lock.token === token) unlinkSync(path);
  } catch {
    // A corrupt lock is not ours to remove.
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
