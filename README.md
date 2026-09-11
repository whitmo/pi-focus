# pi-focus

Project-local work focus for [Pi](https://github.com/badlogic/pi-mono). It keeps an active work objective visible in provider context, offers an interactive `/focus` command UI, and guards tool calls against the active focus's declared tools.

## Install

```bash
pi install git:github.com/whitmo/pi-focus
```

Use `pi install -l` inside a project for project-local installation.

## Storage

Focus data is isolated to the project root found from Pi's current working directory:

```text
.agents/focus/
├── state.json                 # focus index and active focus
└── foci/<focus-id>/
    ├── kb/                    # named Markdown knowledge entries
    └── state/                 # focus-local state files
```

## Commands

- `/focus` — view, switch, or create a focus
- `/focus <query>` — choose an exact/related focus or create one
- `/focus new|on|use|edit|delete|kb|expand|narrow|off|status|help`

## Guard-only tool policy

An active focus may declare its allowed tool names. `pi-focus` guards each tool call: undeclared, unregistered, and inactive declared tools are blocked. A missing declaration leaves the host's active tools unchanged; an explicit empty declaration permits none.

`pi-focus` never calls `setActiveTools`. It neither enables nor disables host tools, and it does not restore tool sets. The declaration is only a guard over tools already active in the host.

`pi-loadout` and `@juicesharp/rpiv-ask-user-question` are optional peer dependencies; no host package is required as a peer. `pi-focus` works without either.

The loadout seam is an agent's explicit `loadout_profile` `push`/`pop` action, not automatic extension invocation. Monitor, script, and subagent intents are declarative runbooks: they require explicit actions. Automatic runtime supervision is not included.

## Test

```bash
npm test
```
