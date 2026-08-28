export function createEmptyState() {
  return {
    activeFocusId: null,
    lastFocusId: null,
    foci: [],
    updatedAt: null,
  };
}

export function createFocus(state, input, now = new Date().toISOString()) {
  const foci = state.foci ?? [];
  const id = uniqueId(slugify(input.name), foci.map((focus) => focus.id));
  const focus = {
    id,
    name: input.name.trim(),
    goals: clean(input.goals),
    scope: clean(input.scope),
    constraints: clean(input.constraints),
    planningDocs: cleanList(input.planningDocs),
    refs: cleanList(input.refs),
    notes: cleanList(input.notes),
    subfocuses: [],
    activeSubfocusId: null,
    createdAt: now,
    updatedAt: now,
  };

  return {
    ...state,
    activeFocusId: id,
    lastFocusId: id,
    foci: [...foci, focus],
    updatedAt: now,
  };
}

export function getActiveFocus(state) {
  return (state.foci ?? []).find((focus) => focus.id === state.activeFocusId) ?? null;
}

export function findMatchingFoci(foci, query) {
  const needle = clean(query).toLowerCase();
  const exact = foci.filter((focus) => focus.id.toLowerCase() === needle || focus.name.toLowerCase() === needle);
  const related = foci.filter((focus) => {
    if (exact.includes(focus)) return false;
    return [focus.id, focus.name, focus.goals, focus.scope, focus.constraints, ...(focus.planningDocs ?? []), ...(focus.refs ?? []), ...(focus.notes ?? [])]
      .filter((value) => typeof value === "string")
      .some((value) => value.toLowerCase().includes(needle));
  });
  return [...exact, ...related.slice(0, 5)];
}

export function setActiveFocus(state, id, now = new Date().toISOString()) {
  if (!(state.foci ?? []).some((focus) => focus.id === id)) {
    throw new Error(`Unknown focus: ${id}`);
  }

  return {
    ...state,
    activeFocusId: id,
    lastFocusId: id,
    updatedAt: now,
  };
}

export function setFocusOff(state, now = new Date().toISOString()) {
  return {
    ...state,
    activeFocusId: null,
    lastFocusId: state.activeFocusId ?? state.lastFocusId ?? null,
    updatedAt: now,
  };
}

export function addFocusNote(state, note, now = new Date().toISOString()) {
  return updateActiveFocus(state, now, (focus) => ({
    ...focus,
    notes: [...(focus.notes ?? []), clean(note)].filter(Boolean),
  }));
}

export function createSubfocus(state, input, now = new Date().toISOString()) {
  return updateActiveFocus(state, now, (focus) => {
    const subfocuses = focus.subfocuses ?? [];
    const id = uniqueId(slugify(input.name), subfocuses.map((subfocus) => subfocus.id));
    return {
      ...focus,
      activeSubfocusId: id,
      subfocuses: [
        ...subfocuses,
        {
          id,
          name: input.name.trim(),
          goals: clean(input.goals),
          scope: clean(input.scope),
          constraints: clean(input.constraints),
          notes: cleanList(input.notes),
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
  });
}

export function summarizeFocus(focus) {
  const lines = [
    `Focus: ${focus.name}`,
    focus.goals ? `Goals: ${focus.goals}` : null,
    focus.scope ? `Scope: ${focus.scope}` : null,
    focus.constraints ? `Constraints: ${focus.constraints}` : null,
    focus.planningDocs?.length ? `Planning docs: ${focus.planningDocs.join(", ")}` : null,
    focus.refs?.length ? `Refs: ${focus.refs.join(", ")}` : null,
    focus.notes?.length ? `Notes: ${focus.notes.slice(-5).join(" | ")}` : null,
  ].filter(Boolean);

  const subfocus = (focus.subfocuses ?? []).find((item) => item.id === focus.activeSubfocusId);
  if (subfocus) {
    lines.push(`Subfocus: ${subfocus.name}`);
    if (subfocus.goals) lines.push(`Subfocus goals: ${subfocus.goals}`);
    if (subfocus.scope) lines.push(`Subfocus scope: ${subfocus.scope}`);
    if (subfocus.constraints) lines.push(`Subfocus constraints: ${subfocus.constraints}`);
  }

  return lines.join("\n");
}

function updateActiveFocus(state, now, update) {
  const active = getActiveFocus(state);
  if (!active) {
    throw new Error("No active focus");
  }

  return {
    ...state,
    foci: (state.foci ?? []).map((focus) =>
      focus.id === active.id ? { ...update(focus), updatedAt: now } : focus
    ),
    updatedAt: now,
  };
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanList(value) {
  if (Array.isArray(value)) {
    return value.map(clean).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(/[\n,]/).map(clean).filter(Boolean);
  }
  return [];
}

function slugify(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "focus";
}

function uniqueId(base, existing) {
  const used = new Set(existing);
  let id = base;
  let count = 2;
  while (used.has(id)) {
    id = `${base}-${count}`;
    count += 1;
  }
  return id;
}
