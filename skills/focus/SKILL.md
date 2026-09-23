---
name: focus
description: Use when asked to set, switch, create, report, or return to the active project work focus.
---

# Focus

Focus context is injected into the model's system prompt from this session's
binding. It must not be repeated in the visible conversation every turn.

Argument-bearing `/skill:focus ...` invocations are handled by the pi-focus
extension before skill expansion. The extension selects or creates the focus,
forwards the remaining task once, and acknowledges a changed focus once. If the
requested focus is already active, continue with the task without another focus
announcement.

When this skill is loaded without arguments:

1. State the bound focus and subfocus in one concise sentence.
2. Align the next action with their goals, scope, constraints, planning docs,
   refs, and project-local knowledge paths.
3. Do not restate the focus on later turns unless the focus changes or the user
   explicitly asks for focus status.

Use `/focus use` to capture the latest catalog revision; `/focus on` restores the
captured prior revision. If no `Current Focus` context is available, ask the user
to run `/focus`.
