---
name: focus
description: Return to the active /focus work context when the user invokes /skill:focus or asks to refocus on the current work.
---

# Focus

Use the active `Current Focus` injected into the system prompt by the `/focus` extension.

When invoked:

1. Re-state the active focus in one concise sentence.
2. Align the next action with its goals, scope, constraints, planning docs, and refs.
3. If no `Current Focus` block is present, ask the user to run `/focus` or `/focus on`.
