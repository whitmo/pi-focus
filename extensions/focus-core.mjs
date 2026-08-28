export function createEmptyState() {
  return {
    activeFocusId: null,
    lastFocusId: null,
    foci: [],
    updatedAt: null,
  };
}

export function normalizeFocusState(state) {
  if (!isRecord(state)) throw new Error("focus: invalid state schema");
  if (state.foci !== undefined && !Array.isArray(state.foci)) throw new Error("focus: invalid state schema");

  return {
    activeFocusId: nullableString(state.activeFocusId, "activeFocusId"),
    lastFocusId: nullableString(state.lastFocusId, "lastFocusId"),
    foci: (state.foci ?? []).map(normalizeFocus),
    updatedAt: nullableString(state.updatedAt, "updatedAt"),
  };
}

export function createFocus(state, input, now = new Date().toISOString()) {
  const normalized = normalizeFocusState(state);
  const id = uniqueId(slugify(input?.name), normalized.foci.map((focus) => focus.id));
  const focus = normalizeFocus({
    id,
    name: clean(input?.name),
    goals: clean(input?.goals),
    scope: clean(input?.scope),
    constraints: clean(input?.constraints),
    planningDocs: cleanList(input?.planningDocs),
    refs: cleanList(input?.refs),
    notes: cleanList(input?.notes),
    activation: cleanActivation(input?.activation),
    subfocuses: [],
    activeSubfocusId: null,
    createdAt: now,
    updatedAt: now,
  });

  return {
    ...normalized,
    activeFocusId: id,
    lastFocusId: id,
    foci: [...normalized.foci, focus],
    updatedAt: now,
  };
}

export function updateFocus(state, id, input, now = new Date().toISOString()) {
  const normalized = normalizeFocusState(state);
  const existing = normalized.foci.find((focus) => focus.id === id);
  if (!existing) throw new Error(`Unknown focus: ${id}`);

  const replacement = normalizeFocus({
    ...existing,
    name: input?.name === undefined ? existing.name : clean(input.name),
    goals: input?.goals === undefined ? existing.goals : clean(input.goals),
    scope: input?.scope === undefined ? existing.scope : clean(input.scope),
    constraints: input?.constraints === undefined ? existing.constraints : clean(input.constraints),
    planningDocs: input?.planningDocs === undefined ? existing.planningDocs : cleanList(input.planningDocs),
    refs: input?.refs === undefined ? existing.refs : cleanList(input.refs),
    notes: input?.notes === undefined ? existing.notes : cleanList(input.notes),
    activation: input?.activation === undefined ? existing.activation : cleanActivation(input.activation),
    updatedAt: now,
  });

  return {
    ...normalized,
    foci: normalized.foci.map((focus) => focus.id === id ? replacement : focus),
    updatedAt: now,
  };
}

export function deleteFocus(state, id, now = new Date().toISOString()) {
  const normalized = normalizeFocusState(state);
  if (!normalized.foci.some((focus) => focus.id === id)) throw new Error(`Unknown focus: ${id}`);

  return {
    ...normalized,
    activeFocusId: normalized.activeFocusId === id ? null : normalized.activeFocusId,
    lastFocusId: normalized.lastFocusId === id ? null : normalized.lastFocusId,
    foci: normalized.foci.filter((focus) => focus.id !== id),
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
  const normalized = normalizeFocusState(state);
  if (!normalized.foci.some((focus) => focus.id === id)) throw new Error(`Unknown focus: ${id}`);

  return {
    ...normalized,
    activeFocusId: id,
    lastFocusId: id,
    updatedAt: now,
  };
}

export function setFocusOff(state, now = new Date().toISOString()) {
  const normalized = normalizeFocusState(state);
  return {
    ...normalized,
    activeFocusId: null,
    lastFocusId: normalized.activeFocusId ?? normalized.lastFocusId ?? null,
    updatedAt: now,
  };
}

export function addFocusNote(state, note, now = new Date().toISOString()) {
  return updateActiveFocus(state, now, (focus) => ({
    ...focus,
    notes: [...focus.notes, clean(note)].filter(Boolean),
  }));
}

export function createSubfocus(state, input, now = new Date().toISOString()) {
  return updateActiveFocus(state, now, (focus) => {
    const id = uniqueId(slugify(input?.name), focus.subfocuses.map((subfocus) => subfocus.id));
    return {
      ...focus,
      activeSubfocusId: id,
      subfocuses: [
        ...focus.subfocuses,
        normalizeSubfocus({
          id,
          name: clean(input?.name),
          goals: clean(input?.goals),
          scope: clean(input?.scope),
          constraints: clean(input?.constraints),
          notes: cleanList(input?.notes),
          createdAt: now,
          updatedAt: now,
        }),
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

function normalizeFocus(focus) {
  if (!isRecord(focus) || !validId(focus.id) || !clean(focus.name)) throw new Error("focus: invalid state schema");
  return omitUndefined({
    id: focus.id,
    name: clean(focus.name),
    goals: clean(focus.goals),
    scope: clean(focus.scope),
    constraints: clean(focus.constraints),
    planningDocs: cleanList(focus.planningDocs),
    refs: cleanList(focus.refs),
    notes: cleanList(focus.notes),
    activation: cleanActivation(focus.activation),
    subfocuses: normalizeSubfocuses(focus.subfocuses),
    activeSubfocusId: nullableString(focus.activeSubfocusId, "activeSubfocusId"),
    createdAt: nullableString(focus.createdAt, "createdAt"),
    updatedAt: nullableString(focus.updatedAt, "updatedAt"),
  });
}

function normalizeSubfocuses(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("focus: invalid state schema");
  return value.map(normalizeSubfocus);
}

function normalizeSubfocus(focus) {
  if (!isRecord(focus) || !validId(focus.id) || !clean(focus.name)) throw new Error("focus: invalid state schema");
  return {
    id: focus.id,
    name: clean(focus.name),
    goals: clean(focus.goals),
    scope: clean(focus.scope),
    constraints: clean(focus.constraints),
    notes: cleanList(focus.notes),
    createdAt: nullableString(focus.createdAt, "createdAt"),
    updatedAt: nullableString(focus.updatedAt, "updatedAt"),
  };
}

function updateActiveFocus(state, now, update) {
  const normalized = normalizeFocusState(state);
  const active = getActiveFocus(normalized);
  if (!active) throw new Error("No active focus");

  return {
    ...normalized,
    foci: normalized.foci.map((focus) =>
      focus.id === active.id ? normalizeFocus({ ...update(focus), updatedAt: now }) : focus
    ),
    updatedAt: now,
  };
}

function cleanActivation(value) {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("focus: invalid activation metadata");
  if (value.tools === undefined) return undefined;
  if (!Array.isArray(value.tools) || value.tools.some((tool) => typeof tool !== "string")) {
    throw new Error("focus: invalid activation metadata");
  }
  return { tools: value.tools.map(clean).filter(Boolean) };
}

function nullableString(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`focus: invalid ${name}`);
  return value;
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanList(value) {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  if (typeof value === "string") return value.split(/[\n,]/).map(clean).filter(Boolean);
  throw new Error("focus: invalid state schema");
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

function validId(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]*$/.test(value);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function omitUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
