# pi-focus

Project-local work focus for [Pi](https://github.com/badlogic/pi-mono). It keeps a running agent's bound work objective visible in provider context, offers an interactive `/focus` command UI, and guards tool calls against the bound focus path's declared tools.

## Install

```bash
pi install git:github.com/whitmo/pi-focus
```

Use `pi install -l` inside a project for project-local installation.

## Storage

Focus definitions and resources are isolated to the project root found from Pi's current working directory:

```text
.agents/focus/
├── .catalog-v1.yaml           # completed-catalog marker; never a selection
├── .state.lock                # migration sentinel blocking v0.1 writers
└── foci/
    └── <focus-id>/
        ├── focus.md            # YAML frontmatter plus free-form Markdown
        ├── retired.yaml        # present instead of focus.md after retirement
        ├── kb/
        ├── state/
        └── subfocuses/
            └── <subfocus-id>/
                ├── subfocus.md # YAML frontmatter plus free-form Markdown
                ├── kb/
                └── state/
```

Directory enumeration is the catalog. `.catalog-v1.yaml` marks a completed v0.1 migration; it never stores an active or last selection. Focus and subfocus definition revisions are captured in immutable `pi-focus:binding` custom entries in Pi's session JSONL. Pi owns that JSONL; pi-focus maintains no JSON state.

Retiring a focus removes its descriptor but preserves its `kb/` and `state/` data. Migration also preserves retired and neighboring KB/state data during the cross-version transition.

## Binding lifecycle

Each running agent owns its active and last focus snapshots. Catalog edits do not change an existing binding: `/focus use` explicitly captures the latest catalog revision, while `/focus on` restores the previously captured revision.

- Initial startup, `/new`, `/resume`, and process restart start unbound; an interactive user is asked to choose again.
- Hot `/reload` restores the latest valid binding on the current session branch.
- `/fork` and `/clone` copy the selected source branch's latest binding, then the new session changes independently.
- Fresh child agents start unbound. Parent/child propagation would require an independently designed optional adapter, which is not included.

## Commands

- `/focus` — view, switch, or create a focus
- `/focus <query>` — choose an exact/related focus or create one
- `/focus new|on|use|edit|delete|kb|expand|narrow|off|status|help`

## Guard-only tool policy

A bound focus or subfocus may declare allowed tool names. `pi-focus` guards each tool call: undeclared, unregistered, and inactive declared tools are blocked. A missing declaration adds no restriction; an explicit empty declaration permits none. When both focus and subfocus declare tools, the effective declaration is their intersection.

`pi-focus` never calls `setActiveTools`. It neither enables nor disables host tools, and it does not restore tool sets. The declaration is only a guard over tools already active in the host.

`pi-loadout` and `@juicesharp/rpiv-ask-user-question` are optional peer dependencies; no host package is required as a peer. `pi-focus` works without either.

The loadout seam is an agent's explicit `loadout_profile` `push`/`pop` action, not automatic extension invocation. Monitor, script, and subagent intents are declarative runbooks: they require explicit actions. Automatic runtime supervision is not included.

## Test

```bash
npm test
```
