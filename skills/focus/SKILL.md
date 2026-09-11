---
name: focus
description: Return to the active /focus work context when the user invokes /skill:focus or asks to refocus on the current work.
---

# Focus

Focus context is injected automatically from the active project-local focus.

When invoked:

1. Re-state the active focus in one concise sentence.
2. Align the next action with its goals, scope, constraints, planning docs, and refs.
3. Loadout, monitor, script, and agent intents are declarative only; make explicit tool calls when needed.
4. Use the project-local focus KB and state paths shown in the injected context.
5. If no `Current Focus` block is present, ask the user to run `/focus` or `/focus on`.
