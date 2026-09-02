# Focus Session Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace project-global JSON focus selection with a human-readable shared catalog and one immutable, session-local binding per running agent.

**Architecture:** Focus and subfocus definitions live in per-container Markdown files with YAML frontmatter. The standalone extension keeps the live binding in its instance and records immutable snapshots as Pi custom session entries. Context and tool guards read only the captured binding; fresh child agents start unbound.

**Tech Stack:** Node.js ESM, TypeScript Pi extension entrypoint, `node:test`, `yaml` 2.9.x, Pi 0.84.3 extension/session APIs.

**Spec:** `.agents/superpowers/specs/2026-09-02-focus-session-identity-design.md`

## Global Constraints

- `FOCUS_BINDING_CUSTOM_TYPE` is exactly `"pi-focus:binding"`.
- The exported consumer functions are exactly `restoreFocusBinding(entries)` and `focusBindingIds(binding)` from `extensions/focus-session.mjs`; neither reads disk, environment, or global state.
- The newest matching malformed/unknown binding returns `null`; never fall back to an older valid binding.
- The live active/last binding is extension-instance-local. No module-global, process-global, cwd-global, environment-global, or project-global selection.
- Project-owned focus data is Markdown/YAML, never maintained JSON. Pi-owned custom session JSONL is the only JSON serialization exception.
- Startup/new/resume starts off and asks again; reload restores; fork copies the selected source branch; tree navigation retains the running identity.
- Catalog edits require explicit rebind. Existing agent snapshots never refresh from disk.
- Focus/subfocus tool declarations compose by intersection; absent is unconstrained and explicit empty denies all.
- pi-focus never calls `setActiveTools`; declarations remain a guard over already-active registered tools.
- Snapshot text is capped at 500 characters; display lists at 8×500; `activation.tools` at 128×200; path YAML at 24,000 bytes; rendered context at 4,000 characters.
- A valid ID is 1–200 lowercase ASCII letters, digits, or hyphens, begins with a letter/digit, and matches `^[a-z0-9][a-z0-9-]*$`; a valid path is exactly a root focus plus at most one child subfocus whose `parentId` matches.
- No compaction implementation, Agent/subagent integration, parent/child propagation, or Clubhouse Agent-definition change belongs in this plan.
- Every fresh non-interactive process or child starts unbound; no prompt, environment value, or shared event assigns it.
- Preserve all v0.1 KB containment, symlink rejection, atomic-write, stale-lock, declaration, and guard-only behavior.

## Scope Revision

Tasks 1–4 were implemented before the user removed parent/child propagation from Layer 2. Task 5 must delete the unapproved transfer/event exports and tests introduced in Task 1 before wiring standalone lifecycle behavior. The abandoned companion Agent plan is not a prerequisite and must not be implemented.

---

### Task 1: Immutable Session Binding Contract

**Files:**
- Create: `extensions/focus-session.mjs`
- Create: `tests/focus-session.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `FOCUS_BINDING_CUSTOM_TYPE`, `createLocalFocusBinding(input)`, `createForkedFocusBinding(sessionId, sourceEntry)`, `normalizeFocusPathSnapshot(value)`, `restoreFocusBinding(entries)`, and `focusBindingIds(binding)`.
- Consumes: YAML parser/serializer from `yaml@^2.9.0`.

- [ ] **Step 1: Install the YAML dependency**

Run:

```bash
npm install yaml@^2.9.0
```

Expected: `package.json` gains runtime dependency `yaml`; `package-lock.json` resolves version 2.9.x.

- [ ] **Step 2: Write failing session-contract tests**

Create `tests/focus-session.test.mjs` with fixtures shaped like:

```js
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
```

Cover these exact cases:

```js
assert.equal(FOCUS_BINDING_CUSTOM_TYPE, "pi-focus:binding");
assert.deepEqual(focusBindingIds(binding), { focusId: "focus-a", subfocusId: null });
assert.equal(focusBindingIds({ ...binding, active: null }), null);
assert.equal(Object.isFrozen(restoreFocusBinding(entries).binding.active.focus), true);
```

Also assert:

- the latest valid matching entry wins;
- the latest matching malformed/unknown-version entry returns `null` instead of reviving an older entry;
- explicit `active: null` survives restore;
- impossible focus/subfocus kind/parent combinations are rejected;
- a nine-tool declaration remains valid;
- 201-character IDs, 129 tools, 501-character bounded fields, and paths over 24,000 bytes are rejected;
- local and fork bindings accept only `source: "local" | "fork"`;
- fork bindings copy the selected source entry under the new session ID with `forkedFrom: { sessionId, entryId }`.

- [ ] **Step 3: Run the new test and observe the expected failure**

Run:

```bash
node --test tests/focus-session.test.mjs
```

Expected: FAIL because `extensions/focus-session.mjs` does not exist.

- [ ] **Step 4: Implement the pure binding module**

Use these exact constants and public signatures:

```js
export const FOCUS_BINDING_CUSTOM_TYPE = "pi-focus:binding";
export const MAX_ID_LENGTH = 200;
export const MAX_FIELD_LENGTH = 500;
export const MAX_LIST_ITEMS = 8;
export const MAX_TOOL_ITEMS = 128;
export const MAX_TOOL_NAME_LENGTH = 200;
export const MAX_PATH_YAML_BYTES = 24_000;

export function restoreFocusBinding(entries) {}
export function focusBindingIds(binding) {}
export function createLocalFocusBinding(input) {}
export function createForkedFocusBinding(sessionId, sourceEntry) {}
export function normalizeFocusPathSnapshot(value) {}
```

Implementation rules:

- Validate into new objects; do not retain caller object references.
- Recursively freeze validated bindings and snapshots.
- Scan branch entries backward to the first matching `customType`; validate that one only.
- Measure normalized path size with `Buffer.byteLength(yaml.stringify(path), "utf8")`.
- `createForkedFocusBinding(sessionId, sourceEntry)` copies the source binding's active/last snapshots, sets `source: "fork"`, and records only `{ sessionId: sourceEntry.binding.agentSessionId, entryId: sourceEntry.entryId }` in `forkedFrom`.

- [ ] **Step 5: Run the focused tests**

Run:

```bash
node --test tests/focus-session.test.mjs
```

Expected: all session-contract tests pass.

- [ ] **Step 6: Commit Task 1**

```bash
git add package.json package-lock.json extensions/focus-session.mjs tests/focus-session.test.mjs
git commit -m "feat: add immutable focus binding contract"
```

---

### Task 2: Catalog Domain and Revisions

**Files:**
- Modify: `extensions/focus-core.mjs`
- Modify: `tests/focus-core.test.mjs`

**Interfaces:**
- Consumes: `normalizeFocusPathSnapshot(value)` from Task 1.
- Produces: `createEmptyCatalog()`, `normalizeFocusCatalog(value)`, `normalizeLegacyFocusState(value)`, `createFocus(catalog, input, now)`, `updateFocus(catalog, id, expected, input, now)`, `retireFocus(catalog, id, expected)`, `addFocusNote(catalog, id, expected, note, now)`, `createSubfocus(catalog, focusId, input, now)`, `updateSubfocus(catalog, focusId, subfocusId, expected, input, now)`, `addSubfocusNote(catalog, focusId, subfocusId, expected, note, now)`, `findMatchingFoci(foci, query)`, `findFocusPath(catalog, focusId, subfocusId)`, and `summarizeFocusPath(path)`.

- [ ] **Step 1: Replace selection-state tests with catalog tests**

Keep the existing matching and activation-normalization assertions. Replace active/last mutation expectations with:

```js
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
assert.throws(
  () => updateFocus(updated.catalog, updated.focus.id, { createdAt: NOW, revision: 1 }, { scope: "stale" }, LATER),
  /stale catalog revision/,
);
```

Add subfocus assertions proving it has its own revision and activation policy, parent ID, update/note transitions, and snapshot path. Creating or editing a subfocus must not increment the parent focus revision because the child document owns its revision. Add ID truncation/suffix tests that never exceed 200 characters. Keep legacy normalization accepting null timestamps so migration can backfill them deterministically.

- [ ] **Step 2: Run the core test and observe selection-shape failures**

Run:

```bash
node --test tests/focus-core.test.mjs
```

Expected: FAIL because v0.1 still returns shared active/last fields and lacks revisions.

- [ ] **Step 3: Refactor `focus-core.mjs` to catalog-only operations**

Use this catalog shape:

```js
{
  foci: Array<FocusRecord>,
  retiredFocusIds: string[],
}
```

Every mutation returns `{ catalog, focus }`, `{ catalog, focus, subfocus }`, or `{ catalog }`; it never selects anything. `updateFocus` and `retireFocus` must compare both `createdAt` and `revision`. `createSubfocus` creates the subfocus at revision 1 without changing the parent definition revision. `updateSubfocus` and `addSubfocusNote` compare the subfocus's own `createdAt`/`revision` and increment only that revision. Normalize subfocuses with the same context and activation fields as focuses.

Keep `normalizeLegacyFocusState` as a read-only migration parser for v0.1 fields. Do not expose legacy active/last selection to catalog consumers.

- [ ] **Step 4: Run core and session tests**

Run:

```bash
node --test tests/focus-core.test.mjs tests/focus-session.test.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Commit Task 2**

```bash
git add extensions/focus-core.mjs tests/focus-core.test.mjs
git commit -m "refactor: separate focus catalog from selection"
```

---

### Task 3: Markdown Catalog, Migration, and Locked KB Writes

**Files:**
- Modify: `extensions/focus-store.mjs`
- Modify: `tests/focus-store.test.mjs`

**Interfaces:**
- Consumes: Task 2 catalog transition return shapes and `normalizeLegacyFocusState`.
- Produces: `loadFocusCatalog(cwd)`, `updateFocusCatalog(cwd, update)`, `focusRoot(cwd)`, `focusDirectory(cwd, focusId)`, `subfocusDirectory(cwd, focusId, subfocusId)`, `ensureContainerDirectories(cwd, focusId, subfocusId?)`, and KB functions accepting optional `subfocusId`.
- `updateFocusCatalog(cwd, update)` consumes `update(catalog) -> { catalog, ...result }`, persists the returned catalog under one lock, and returns the same result object.

- [ ] **Step 1: Rewrite store acceptance tests around Markdown/YAML**

Add helpers that inspect files using normal filesystem reads. Cover:

```js
const result = updateFocusCatalog(project, (catalog) => createFocus(catalog, { name: "Focus A" }, NOW));
const document = readFileSync(join(project, ".agents/focus/foci/focus-a/focus.md"), "utf8");
assert.match(document, /^---\n/);
assert.match(document, /revision: 1/);
assert.equal(existsSync(join(project, ".agents/focus/state.json")), false);
assert.equal(loadFocusCatalog(project).foci[0].name, "Focus A");
```

Preserve the existing atomic replacement, containment, traversal, symlink, stale-lock, and concurrent-update cases. Add exact cases for:

- preserving Markdown body text across an extension-driven frontmatter edit;
- focus and subfocus KB paths;
- one catalog lock covering KB write/delete and retirement;
- in-place `retired.yaml` preventing ID reuse while preserving `kb/` and `state/`;
- legacy migration ignoring active/last/activeSubfocus selection;
- null legacy timestamps using catalog timestamp then Unix epoch;
- unmarked partial migration retry removing stale descriptors but retaining neighboring KB/state;
- exact descriptor enumeration before `.catalog-v1.yaml` appears;
- permanent YAML `.state.lock` sentinel after success and lock release after failure;
- no maintained JSON writes after migration.

- [ ] **Step 2: Run the store test and observe failures**

Run:

```bash
node --test tests/focus-store.test.mjs
```

Expected: FAIL because v0.1 still reads/writes `state.json` and uses `.state.lock` JSON.

- [ ] **Step 3: Implement Markdown document encoding**

Parse exact frontmatter boundaries and preserve the body verbatim:

```js
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/;
```

Map camelCase runtime fields to snake_case YAML fields and back. Use `yaml.parse`/`yaml.stringify` with deterministic key order and no executable YAML tags. New documents have an empty body; updates read and reuse the existing body.

- [ ] **Step 4: Replace shared JSON persistence with catalog enumeration**

Implement:

```js
export function loadFocusCatalog(cwd) {}
export function updateFocusCatalog(cwd, update) {}
export function subfocusDirectory(cwd, focusId, subfocusId) {}
export function ensureContainerDirectories(cwd, focusId, subfocusId = null) {}
```

Persist only changed descriptors, removed descriptors, and retirement markers while holding `.catalog.lock`. Build the lock as an atomic directory with `owner.yaml`; preserve v0.1's bounded retry, stale-PID detection, and never-auto-reclaim behavior.

Wrap KB create/edit/delete in the same lock, re-read the descriptor/retired marker after lock acquisition, and reject writes to retired or missing containers.

- [ ] **Step 5: Implement idempotent legacy migration**

Acquire `.catalog.lock` first and then the temporary v0.1 `.state.lock` (new writers use only the first; old writers use only the second, so this order cannot deadlock), then:

- hash the source bytes;
- preflight IDs before writing;
- materialize revision-1 focus/subfocus documents;
- reconcile descriptor and retirement-marker enumeration exactly;
- preserve KB/state directories;
- read all documents back and compare normalized fields;
- recheck the legacy hash;
- atomically write `.catalog-v1.yaml` last;
- replace `.state.lock` contents with YAML `migrated: true` and do not release it after success;
- release both temporary locks when migration fails before completion.

When the marker exists, never read or write legacy `state.json`.

- [ ] **Step 6: Run store, core, and session tests**

Run:

```bash
node --test tests/focus-store.test.mjs tests/focus-core.test.mjs tests/focus-session.test.mjs
```

Expected: all tests pass and temporary directories contain no orphan temporary files.

- [ ] **Step 7: Commit Task 3**

```bash
git add extensions/focus-store.mjs tests/focus-store.test.mjs
git commit -m "feat: store focus catalog as markdown"
```

---

### Task 4: Snapshot Context and Guard Composition

**Files:**
- Modify: `extensions/focus-runtime.mjs`
- Modify: `tests/focus-runtime.test.mjs`

**Interfaces:**
- Consumes: immutable `FocusPathSnapshotV1` values from Task 1.
- Produces: `effectiveToolDeclaration(path)`, `resolvePathToolPolicy(path, registered, active)`, and `buildFocusContext(path, paths, capabilities)`.
- Preserves: `activationCapabilities()` and the host registration/active-set behavior of `resolveToolPolicy()`.

- [ ] **Step 1: Update runtime tests to pass focus paths**

Add these policy cases:

```js
assert.equal(effectiveToolDeclaration({ focus: noPolicy, subfocus: noPolicySub }), undefined);
assert.deepEqual(effectiveToolDeclaration({ focus: tools("read", "grep"), subfocus: tools("grep", "write") }), ["grep"]);
assert.deepEqual(effectiveToolDeclaration({ focus: tools("read"), subfocus: tools() }), []);
```

Assert context renders both focus and subfocus names/context, identifies both captured revisions, lists each inert activation declaration, names focus/subfocus KB/state paths, and remains at most 4,000 characters. Assert no store module or KB read is required.

- [ ] **Step 2: Run runtime tests and observe fixture/API failures**

Run:

```bash
node --test tests/focus-runtime.test.mjs
```

Expected: FAIL because v0.1 `buildFocusContext` accepts one mutable focus and one policy.

- [ ] **Step 3: Implement path-aware context and policy**

Compute declarations as:

```js
const declared = [path.focus.activation?.tools, path.subfocus?.activation?.tools]
  .filter((value) => value !== undefined);
if (!declared.length) return undefined;
return declared.reduce((left, right) => left.filter((name) => right.includes(name)));
```

Keep registration/active filtering in `resolveToolPolicy`; do not activate tools. Render captured data only. Remove the `state.json` index path from output.

- [ ] **Step 4: Run runtime tests**

Run:

```bash
node --test tests/focus-runtime.test.mjs tests/focus-session.test.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Commit Task 4**

```bash
git add extensions/focus-runtime.mjs tests/focus-runtime.test.mjs
git commit -m "feat: render and guard captured focus paths"
```

---

### Task 5: Session Lifecycle and Focus Commands

**Files:**
- Modify: `extensions/focus-session.mjs`
- Modify: `tests/focus-session.test.mjs`
- Modify: `extensions/index.ts`
- Modify: `tests/focus-extension.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–4 APIs after removing rejected transfer/event exports.
- Produces: standalone `pi-focus:binding`, `restoreFocusBinding`, `focusBindingIds`, and one extension-instance-local `{ entryId, binding } | null`; Pi handlers for `session_start`, `session_tree`, `session_shutdown`, `context`, and `tool_call`; existing `/focus` command with autocomplete.

- [ ] **Step 1: Build a Pi-shaped session test harness**

Extend the fake API with:

```js
const sessionManager = {
  sessionId,
  branch: [],
  getSessionId() { return this.sessionId; },
  getBranch() { return [...this.branch]; },
  getLeafId() { return this.branch.at(-1)?.id ?? null; },
};
pi.appendEntry = (customType, data) => {
  sessionManager.branch.push({
    type: "custom",
    id: `entry-${sessionManager.branch.length + 1}`,
    parentId: sessionManager.getLeafId(),
    customType,
    data,
  });
};
```

Keep catalog fixtures on disk but assert context/guard behavior comes from session snapshots, not later file edits.

- [ ] **Step 2: Add failing lifecycle and concurrency tests**

Add exact scenarios:

- two extension instances share one catalog, bind different focus IDs, and keep independent context/tool guards;
- switching instance A never alters instance B;
- `session_start: reload` restores latest branch binding;
- startup/new/resume append off and never import historical active/last;
- `/fork` and `/clone` both arrive as `session_start` reason `fork`; that event copies only the selected source branch entry into the new session ID;
- tree navigation appends the current snapshot at the new leaf;
- shutdown clears only closure memory;
- catalog edit by A rebinds A to revision 2 while B remains revision 1;
- deleting A's active container turns A off while B keeps its snapshot;
- append success and simulated post-leaf persistence throw both reconcile closure state from `getBranch()`;
- no handler invokes `setActiveTools`;
- existing `/focus` argument completions include stored focus IDs;
- a fresh non-interactive child starts with `active: null` even when test fixtures model a focused parent prompt/environment;
- `focus-session.mjs` exports no Agent event constant, transfer constructor/codec/parser, or parent-inherited/parent-assigned source.

- [ ] **Step 3: Run extension tests and observe shared-state failures**

Run:

```bash
node --test tests/focus-extension.test.mjs
```

Expected: FAIL because v0.1 reloads active selection from shared disk on every context/tool call.

- [ ] **Step 4: Rewire extension state and lifecycle**

Inside `focusExtension(pi)`, declare only closure state:

```ts
let current: { entryId: string; binding: FocusBindingV1 } | null = null;
let sessionCwd = process.cwd();
```

Implement one `appendAndReconcile(ctx, binding)` helper that calls `pi.appendEntry`, catches/report persistence errors, then always assigns `current = restoreFocusBinding(ctx.sessionManager.getBranch())`.

Lifecycle rules:

- every session start: set `sessionCwd = ctx.cwd`;
- reload: restore only;
- fork (the shared Pi lifecycle reason for `/fork` and `/clone`): restore the selected branch, create a `source: "fork"` copy under the new session ID, and append;
- startup/new/resume: append a `source: "local"` off binding, then open the chooser only when `ctx.hasUI`;
- tree: append the unchanged current binding at the new leaf;
- shutdown: clear closure values.

First delete the rejected `SUBAGENT_BEFORE_CHILD_START`, transfer constructors/codecs/parsers, transfer limits, parent source variants, and their tests from `focus-session.mjs`. Keep the approved custom type, local/fork constructors, path validation, restore resolver, and ID helper.

Rewrite every command to load/mutate catalog explicitly and append a new binding only after successful mutation. `/focus on` uses captured `last`; `/focus use` resolves current catalog. Context, status, title, and guard read `current?.binding.active` only.

Port the existing Clubhouse completion behavior into canonical `index.ts`: static subcommands plus `use <stored-id>` suggestions from `loadFocusCatalog(sessionCwd)`.

- [ ] **Step 5: Run extension tests**

Run:

```bash
node --test tests/focus-extension.test.mjs
```

Expected: all lifecycle, command, isolation, autocomplete, and guard-only tests pass.

- [ ] **Step 6: Run all canonical tests**

Run:

```bash
npm test
```

Expected: zero failures.

- [ ] **Step 7: Commit Task 5**

```bash
git add extensions/focus-session.mjs tests/focus-session.test.mjs extensions/index.ts tests/focus-extension.test.mjs
git commit -m "feat: bind focus to the running session"
```

---

### Task 6: Standalone Documentation and Package Verification

**Files:**
- Modify: `README.md`
- Modify: `skills/focus/SKILL.md`
- Modify: `.agents/superpowers/specs/2026-09-02-focus-session-identity-design.md` only if implementation required a recorded ruling

**Interfaces:**
- Consumes: Tasks 1–5 standalone behavior.
- Produces: user-facing storage/lifecycle documentation and a package with only the independent binding consumer API.

- [ ] **Step 1: Update README storage and lifecycle documentation**

Document the exact Markdown layout, `.catalog-v1.yaml`, immutable `pi-focus:binding` session entry, startup/new/resume/reload/fork rules, explicit rebind semantics, and focus/subfocus guard intersection.

State explicitly that Pi owns session JSONL, pi-focus maintains no JSON state, fresh child agents start unbound, and parent/child propagation requires an independently designed optional adapter that is not included. Retired KB/state data remains during cross-version migration.

- [ ] **Step 2: Update the focus skill**

Keep command instructions concise. Replace shared “active focus” wording with running-agent binding wording and explain that `/focus use` captures the latest catalog revision while `/focus on` restores the captured prior revision. Do not mention Agent prompts, transfer directives, environment inheritance, or launch events.

- [ ] **Step 3: Run package and static verification**

Run:

```bash
npm test
npm pack --dry-run
! grep -R 'writeFileSync.*state.json\|activeFocusId.*write\|lastFocusId.*write' extensions
! grep -R 'SUBAGENT_BEFORE_CHILD_START\|FocusBindingTransfer\|pi-focus-binding' extensions tests README.md skills
```

Expected:

- all tests pass;
- dry-run package includes `extensions/focus-session.mjs`;
- grep finds no maintained legacy JSON selection write or parent/child propagation implementation.

- [ ] **Step 4: Check the complete diff**

Run:

```bash
git diff --check
git status --short
git diff --stat v0.1
```

Expected: no whitespace errors; only planned source/tests/docs/dependency files changed.

- [ ] **Step 5: Commit Task 6**

```bash
git add README.md skills/focus/SKILL.md .agents/superpowers/specs/2026-09-02-focus-session-identity-design.md docs/superpowers/plans/2026-09-02-focus-session-identity.md
git commit -m "docs: explain standalone focus identity"
```
