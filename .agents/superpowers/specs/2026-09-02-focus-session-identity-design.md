# Focus Session Identity Design

**Status:** Approved  
**Date:** 2026-09-02  
**Base:** `pi-focus` v0.1 (`9ed6ee4`)

## Purpose

Make focus membership part of one running agent's identity without making the active selection a property of the repository, working directory, environment, or another process. A focus or subfocus is a persistent project-local container. Agents join containers for the lifetime of their running identity and leave when that identity exits.

This change is the lower layer for asynchronous focus-aware compaction. Background work must capture one immutable focus-binding snapshot and must not follow later focus switches or catalog edits.

## Requirements

1. Concurrent Pi processes in one project may use different focus/subfocus selections without affecting one another.
2. Focus and subfocus definitions persist independently of live membership.
3. Each running agent has at most one active focus path: one focus and optionally one subfocus.
4. Every fresh process or child agent starts unbound. pi-focus does not infer or receive selection from a parent prompt, environment, Agent tool, or shared launch event.
5. Catalog edits do not affect already-running agents. An explicit rebind captures the newer revision.
6. Hot `/reload` preserves the current running identity's binding.
7. Startup, `/new`, `/resume`, and process restart do not automatically restore an old selection. Interactive users choose again; non-interactive agents remain off.
8. `/fork` and `/clone` inherit the latest binding on the selected source branch as a copied snapshot; they do not import a later binding from another branch.
9. Agent exit removes live membership. No durable agent roster is stored in a focus.
10. Preserve v0.1's guard-only tool policy: declarations restrict already-active tools but never activate, deactivate, or restore tools.
11. Project-owned catalog and selection storage must not use JSON.
12. Public pi-focus remains standalone; parent/child focus propagation belongs to an optional future adapter.

## Ownership Model

### Persistent project catalog

The project owns focus/subfocus definitions and their knowledge/state directories. It does not own an active or last selection.

```text
.agents/focus/
├── .catalog-v1.yaml           # completed-catalog marker; never active selection
├── .state.lock                # YAML migration sentinel blocking v0.1 writers
├── foci/
│   └── <focus-id>/
│       ├── focus.md            # absent after retirement
│       ├── retired.yaml        # present only after retirement
│       ├── kb/
│       ├── state/
│       └── subfocuses/
│           └── <subfocus-id>/
│               ├── subfocus.md
│               ├── kb/
│               └── state/
```

Each `focus.md` or `subfocus.md` is Markdown with YAML frontmatter. Frontmatter contains the machine-readable record; the Markdown body is retained as free-form project documentation and is not interpreted by the guard.

Example frontmatter (required identity keys are `kind`, `id`, `parent_id`, `name`, `created_at`, `updated_at`, and `revision`):

```yaml
---
kind: focus
id: devenv-workspace
parent_id: null
name: Devenv Workspace
created_at: 2026-09-02T00:00:00.000Z
updated_at: 2026-09-02T00:00:00.000Z
revision: 1
goals: Clean up and document this workspace
scope: Workspace tooling and durable documentation
constraints: Preserve unrelated work
planning_docs: []
refs: []
notes: []
activation:
  tools: []
  loadout_preset: agents
  monitors: []
  scripts: []
  agents: []
---
```

`revision` is a positive integer. Creation starts at `1`; every definition edit increments it. `created_at` is stable and distinguishes a recreated ID from an older container. Empty and absent tool declarations remain distinct because an explicit empty list means no tool is permitted.

Subfocus records use the same fields with `kind: subfocus` and `parent_id: <focus-id>`. This gives both container types the same context and guard-policy capabilities.

Directory enumeration replaces a central catalog index. Atomic file replacement and symlink/path containment checks from v0.1 remain. Every catalog mutation, KB write/delete, and container retirement uses one atomic lock directory, `.agents/focus/.catalog.lock`, with YAML owner metadata, and revalidates the target after acquiring it. Retirement removes the descriptor but leaves the original directory with `retired.yaml`; new writers reject that marker, while an already-running v0.1 KB writer can add only ignored data beside it and cannot recreate a catalog record. KB/state contents are retained rather than deleted during the cross-version transition. The in-place marker prevents ID reuse without a serialized index.

### Running agent binding

The active and last selections live in the focus extension instance for one running Pi session. No module-global, process-global, environment-global, repository-global, or cwd-derived active value exists.

Every binding change appends an immutable Pi custom session entry. Pi owns its JSONL session format; pi-focus does not create or update a JSON state file. The entry is an event record and is not authoritative project catalog state.

```ts
export const FOCUS_BINDING_CUSTOM_TYPE = "pi-focus:binding";

type FocusBindingV1 = {
  version: 1;
  agentSessionId: string;
  capturedAt: string;
  source: "local" | "fork";
  active: FocusPathSnapshotV1 | null;
  last: FocusPathSnapshotV1 | null;
  forkedFrom?: {
    sessionId: string;
    entryId: string;
  };
};

type FocusPathSnapshotV1 = {
  focus: ContainerSnapshotV1;
  subfocus: ContainerSnapshotV1 | null;
};

type ContainerSnapshotV1 = {
  kind: "focus" | "subfocus";
  id: string;
  parentId: string | null;
  name: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  goals: string;
  scope: string;
  constraints: string;
  planningDocs: string[];
  refs: string[];
  notes: string[];
  activation?: {
    tools?: string[];
    loadoutPreset?: string;
    monitors?: string[];
    scripts?: string[];
    agents?: string[];
  };
};
```

`active: null` records an explicit off state so reload cannot resurrect an older active entry. `last` supports `/focus on` and is itself a captured revision. Restored values are validated, cloned, and recursively frozen before use. Every path requires `focus.kind === "focus"`, `focus.parentId === null`, and, when present, `subfocus.kind === "subfocus"` with `subfocus.parentId === focus.id`. IDs are 1–200 lowercase ASCII letters, digits, or hyphens, beginning with a letter or digit; path depth is exactly one focus plus at most one subfocus. Snapshot names/context strings are capped at 500 characters; `planningDocs`, `refs`, `notes`, `monitors`, `scripts`, and `agents` are capped at 8 items of 500 characters; `activation.tools` is the explicit exception and retains up to 128 tool names of 200 characters so guard semantics are not reduced to the display-list limit. A path snapshot's serialized YAML is capped at 24,000 UTF-8 bytes. Provider focus context retains v0.1's 4,000-character total cap. Catalog documents retain longer prose/list values; snapshot creation applies these deterministic per-field and aggregate caps, rejecting a path that still exceeds 24,000 bytes.

The snapshot contains resolved context and guard policy. Context injection and tool checks use only the current snapshot, never a fresh catalog read. Therefore another process editing or deleting a catalog entry cannot alter a running agent.

## Public Session Interface

Create `extensions/focus-session.mjs` with these pure exports:

```ts
export const FOCUS_BINDING_CUSTOM_TYPE = "pi-focus:binding";

export function restoreFocusBinding(entries):
  { entryId: string; binding: FocusBindingV1 } | null;

export function focusBindingIds(binding):
  { focusId: string; subfocusId: string | null } | null;
```

`restoreFocusBinding(entries)`:

- examines only the supplied root-to-leaf branch entries;
- locates the latest `pi-focus:binding` entry and returns it only when valid;
- returns `null` when no matching entry exists or the latest matching entry is malformed or has an unknown version; it never resurrects an older valid binding behind an invalid newer entry;
- performs no catalog, filesystem, environment, or global-state read.

`focusBindingIds(binding)` returns `null` for invalid or inactive bindings. Consumers such as focus-aware compaction use this helper rather than inspect payload fields. They pass `sessionManager.getBranch()` to the resolver—not compaction-pruned context entries, which may omit an older binding—and may serialize the returned binding opaquely but must not mutate it or resolve current disk state.

## Lifecycle

| Event | Behavior |
|---|---|
| Initial startup | Start off, append the off binding, and ask an interactive user to choose. |
| `/new` | Start off and ask again. Do not copy the old session's last selection. |
| `/resume` or process restart | Ignore historical binding entries, start off, and ask again. |
| Hot `/reload` | Restore the latest valid binding from `sessionManager.getBranch()`. |
| `/fork` or `/clone` | Restore the selected source branch's latest binding—not a later binding from another branch—append an inherited copy for the new session ID, then operate independently. |
| `/tree` navigation | Keep the running agent's current binding and append that snapshot at the new leaf so a later reload remains stable. |
| `/focus use`, chooser, or creation | Resolve the newest catalog revision and append a local binding. |
| `/focus off` | Append `active: null` while retaining the prior snapshot as `last`. |
| `/focus on` | Reactivate the captured `last` revision. `/focus use` is required to acquire a newer catalog revision. |
| Edit/expand/narrow by this agent | Commit the catalog mutation, then explicitly bind this agent to the resulting revision. Other agents remain unchanged. |
| Delete active container | The deleting agent goes off. Other running agents keep their immutable snapshots. |
| Exit | Discard in-memory membership. Historical entries remain inert and are ignored on restart/resume. |

If an interactive startup chooser is cancelled, the agent remains off. Non-interactive fresh processes—including subagents—remain off until that same running agent explicitly chooses a focus through a host that supports the command UI.

## Standalone Child Behavior

pi-focus does not import, patch, configure, or listen to an Agent/subagent package. It does not inspect Agent prompts, mutate tool inputs, accept focus bindings from environment variables, or depend on a shared launch event. Loading pi-focus in a fresh child follows ordinary `session_start` behavior: the child appends its own local off binding and remains unbound because it has no interactive chooser.

An optional future adapter may define parent/child assignment using pi-focus's public binding helpers, but that adapter must be independently designed, versioned, installed, and approved. It is not part of Layer 2, the Clubhouse roll-off work, or the standalone public package.

## Catalog Migration

When `.agents/focus/.catalog-v1.yaml` is absent and legacy `.agents/focus/state.json` exists, migration runs under the catalog lock:

1. Acquire v0.1's `.state.lock` before reading and keep that path as a YAML `migrated: true` sentinel after successful migration. Old v0.1 writers then fail closed instead of updating ignored JSON; a failed migration releases its temporary legacy lock.
2. Read and normalize the legacy file with v0.1 validation. A missing/null legacy `createdAt` or `updatedAt` deterministically uses the legacy catalog `updatedAt`, then `1970-01-01T00:00:00.000Z` if that is also absent. Preflight every legacy ID against the new 200-character/path rules before writing anything; longer prose/list values remain in the Markdown catalog and are capped only when a runtime snapshot is created.
3. Idempotently write one revision-1 Markdown document for every focus and subfocus.
4. Reconcile unmarked descriptor files to the exact locked legacy record set: remove stale generated `focus.md`/`subfocus.md` descriptors while preserving any adjacent `kb/` and `state/` data, then create knowledge/state directories for current records without changing their contents.
5. Reconcile in-place `retired.yaml` markers to `retiredFocusIds`; descriptors for retired IDs stay absent while adjacent KB/state data is preserved.
6. Verify every written record by reading it back and comparing normalized fields; verify descriptor enumeration exactly matches the legacy focus/subfocus set and marker count; and verify the legacy source hash has not changed while the lock is held.
7. Atomically write `.catalog-v1.yaml` with schema version, source SHA-256, record count, and completion timestamp only after full verification. Partial documents without this marker are not treated as a complete catalog; the next run retries from legacy input.
8. Replace the held `.state.lock` contents with the YAML migration sentinel and stop using `state.json`; never update its active/last fields.
9. Report that the verified legacy file may be removed. The Clubhouse migration removes it because Git history is the backup, while retaining the non-JSON sentinel until old runtimes have exited.

Legacy `activeFocusId`, `lastFocusId`, and `activeSubfocusId` are never imported into a running identity. Legacy `.agents/.current-focus` is never read or written and may be removed during project migration. Startup/resume still requires selection.

## Guard and Context Behavior

- Missing `activation.tools` means that container adds no restriction.
- Explicit `activation.tools: []` permits no tools.
- When both focus and subfocus define `activation.tools`, the effective declaration is their intersection; an absent declaration is unconstrained and an explicit empty declaration makes the intersection empty.
- Declared tools must still be registered and active in the host.
- pi-focus never calls `setActiveTools`.
- Context injection uses the immutable active focus/subfocus snapshots and project-local resource paths.
- Knowledge-base contents remain opt-in and are not automatically injected.
- Loadout, monitor, script, and agent declarations remain inert runbooks requiring explicit invocation.

## Failure Behavior

- Catalog write failure leaves the old file and current binding unchanged.
- After any binding append success or exception, the extension reconciles its closure-local value from `restoreFocusBinding(sessionManager.getBranch())`, keeping runtime context/guard behavior identical to what hot reload and compaction can observe. If Pi advanced the in-memory leaf before a persistence error, that new valid binding remains active for this process and the extension warns that it may not survive a crash; otherwise the prior binding remains. Restart/resume asks again in either case.
- Missing/deleted catalog files do not invalidate an existing snapshot.
- A stale catalog edit fails on `createdAt`/`revision` mismatch rather than overwrite newer work.
- Locks, catalog paths, documents, and knowledge entries reject symlinks and traversal.

## Verification

Acceptance coverage must prove:

1. Two extension instances sharing one catalog select different focuses and retain independent context and guards.
2. One agent switching does not change another or an already-running child.
3. Hot reload restores; startup and resume ignore historical bindings.
4. Fork inherits the selected source branch's copy—not a later binding on another branch—and then diverges independently.
5. Tree navigation retains the current running identity.
6. A freshly started non-interactive child is off even when its parent is focused; no prompt/environment/tool event can assign it.
7. Catalog edits require explicit rebind; old snapshots continue to render and guard identically.
8. `restoreFocusBinding` and `focusBindingIds` are pure and reject malformed/unknown versions; a binding with nine declared tools remains valid under the 128-tool guard-policy exception while aggregate path limits still hold.
9. Explicit off entries prevent older selections from resurfacing.
10. Legacy JSON migrates to Markdown without importing active/last selection.
11. The catalog contains no maintained JSON state file.
12. Existing guard-only, KB containment, atomic-write, locking, and declaration-bound tests remain green.
13. The Clubhouse vendored extension retains its existing command autocomplete behavior.

## Non-goals

- Persisting or reconstructing a roster of running agents.
- Automatically changing live agents when catalog files change.
- Activating loadouts, tools, monitors, scripts, or agents.
- Implementing focus-aware compaction in this layer.
- Parent/child focus inheritance or assignment.
- Agent tool, mention, nested-agent, workflow, scheduler, RPC, or environment integration.
- Configuring Clubhouse Agent definitions to load focus.
- Restoring a previous focus automatically after process restart or `/resume`.
