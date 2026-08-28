# pi-focus

Project-local work focus for [Pi](https://github.com/badlogic/pi-mono).

## Install

```bash
pi install git:github.com/whitmo/pi-focus
```

Use `pi install -l` inside a project for project-local installation.
Focus history stays in that project's `.agents/focus/state.json`.

`pi-loadout` and `@juicesharp/rpiv-ask-user-question` are optional peers.
`pi-focus` works without either package.

## Commands

- `/focus` — view, switch, or create a focus
- `/focus <query>` — choose an exact/related focus or create one
- `/focus new|on|use|expand|narrow|off|status|help`

## Test

```bash
npm test
```
