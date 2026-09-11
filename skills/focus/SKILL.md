---
name: focus
description: Return to this running agent's bound /focus context when the user invokes /skill:focus or asks to refocus on the current work.
---

# Focus

Focus context is injected automatically from this running agent's immutable binding.

When invoked:

1. Re-state the bound focus and subfocus in one concise sentence.
2. Align the next action with their goals, scope, constraints, planning docs, and refs.
3. Use the project-local KB and state paths shown in the injected context.
4. Use `/focus use` to capture the latest catalog revision; `/focus on` restores the captured prior revision.
5. If no `Current Focus` block is present, ask the user to run `/focus` or `/focus on`.
