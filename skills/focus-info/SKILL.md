---
name: focus-info
description: Use when asked about the active focus, its goals, scope, constraints, or knowledge; or when the conversation lacks a Current Focus block and you need to derive focus context from the focus state file.
---

# Focus Info

Derive accurate information about the current pi-focus by reading the focus state JSON file directly, rather than guessing from conversation history.

## Data Sources

### Primary: `.agents/focus/state.json`

The canonical focus state. Read it from the project root:

```
<root>/.agents/focus/state.json
```

Structure (call `getActiveFocus()` to extract the active one):

```json
{
  "activeFocusId": "scaf",          // id of the currently active focus
  "lastFocusId": "scaf",            // previous active focus id
  "retiredFocusIds": [],            // deleted focus ids
  "foci": [                         // all defined foci
    {
      "id": "scaf",
      "name": "SCAF",
      "goals": "What are we trying to accomplish?",
      "scope": "What is in bounds?",
      "constraints": "What must stay true?",
      "planningDocs": ["path/to/plan.md"],
      "refs": ["relevant links or file paths"],
      "notes": ["latest notes first"],
      "activation": {               // optional, tool/loadout configuration
        "tools": ["read", "write"],
        "loadoutPreset": "default"
      },
      "subfocuses": [               // nested sub-foci
        {
          "id": "sub-task-1",
          "name": "Sub Task 1",
          "goals": "Narrower goal",
          "scope": "Limited scope",
          "constraints": "Specific constraint",
          "notes": []
        }
      ],
      "activeSubfocusId": null,     // currently active subfocus
      "createdAt": "2026-09-11T20:52:42.707Z",
      "updatedAt": "2026-09-11T20:52:42.707Z"
    }
  ],
  "updatedAt": "2026-09-11T20:52:42.707Z"
}
```

### Secondary: Knowledge entries

Per-focus knowledge base at `.agents/focus/foci/<focusId>/kb/*.md`. List and read entries to enrich the focus context with captured knowledge.

## How to Derive Focus Info

1. **Read state.json** — `cat .agents/focus/state.json`
2. **Find active focus** — match `activeFocusId` against the `foci` array
3. **Extract structured info** — goals, scope, constraints, planning docs, refs
4. **Check subfocus** — if `activeSubfocusId` is set, extract the matching subfocus
5. **Read knowledge entries** — list `ls <root>/.agents/focus/foci/<focusId>/kb/*.md` and read relevant entries
6. **Synthesize** — present a coherent picture of what is being worked on

## When to Use

- User asks "what's the focus?" or "what should I be working on?"
- No `Current Focus` block is present in the system prompt
- Need to determine goals/scope/constraints before taking action
- Need to load planning docs or refs referenced by the current focus

## Common Mistakes

- **Guessing** from conversation history instead of reading state.json
- **Not checking** the focused subfocus when `activeSubfocusId` is set
- **Missing knowledge entries** — always check the kb/ directory for richer context
- **Not reading** referenced planning docs or refs listed in the focus