import { normalizeFocusPathSnapshot } from "./focus-session.mjs";

export function createEmptyCatalog() {
  return {
    foci: [],
    retiredFocusIds: [],
  };
}

export function normalizeFocusCatalog(value) {
  if (!isRecord(value) || (value.foci !== undefined && !Array.isArray(value.foci))) {
    throw new Error("focus: invalid catalog schema");
  }

  return {
    foci: (value.foci ?? []).map(normalizeFocus),
    retiredFocusIds: normalizeFocusIds(value.retiredFocusIds),
  };
}

export function normalizeLegacyFocusState(value) {
  if (!isRecord(value) || (value.foci !== undefined && !Array.isArray(value.foci))) {
    throw new Error("focus: invalid state schema");
  }

  return {
    activeFocusId: nullableString(value.activeFocusId, "activeFocusId"),
    lastFocusId: nullableString(value.lastFocusId, "lastFocusId"),
    retiredFocusIds: normalizeFocusIds(value.retiredFocusIds),
    foci: (value.foci ?? []).map(normalizeLegacyFocus),
    updatedAt: nullableString(value.updatedAt, "updatedAt"),
  };
}

export function createFocus(catalog, input, now = new Date().toISOString()) {
  const normalized = normalizeFocusCatalog(catalog);
  const id = uniqueId(
    slugify(input?.name),
    [...normalized.foci.map((focus) => focus.id), ...normalized.retiredFocusIds],
  );
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
    createdAt: now,
    updatedAt: now,
    revision: 1,
  });

  return {
    catalog: {
      ...normalized,
      foci: [...normalized.foci, focus],
    },
    focus,
  };
}

export function updateFocus(catalog, id, expected, input, now = new Date().toISOString()) {
  const normalized = normalizeFocusCatalog(catalog);
  const existing = findFocus(normalized, id);
  assertExpected(existing, expected);
  if (input?.activation !== undefined && !isRecord(input.activation)) {
    throw new Error("focus: invalid activation metadata");
  }

  const focus = normalizeFocus({
    ...existing,
    name: input?.name === undefined ? existing.name : clean(input.name),
    goals: input?.goals === undefined ? existing.goals : clean(input.goals),
    scope: input?.scope === undefined ? existing.scope : clean(input.scope),
    constraints: input?.constraints === undefined ? existing.constraints : clean(input.constraints),
    planningDocs: input?.planningDocs === undefined ? existing.planningDocs : cleanList(input.planningDocs),
    refs: input?.refs === undefined ? existing.refs : cleanList(input.refs),
    notes: input?.notes === undefined ? existing.notes : cleanList(input.notes),
    activation: input?.activation === undefined
      ? existing.activation
      : cleanActivation({ ...existing.activation, ...input.activation }),
    updatedAt: now,
    revision: existing.revision + 1,
  });

  return {
    catalog: replaceFocus(normalized, focus),
    focus,
  };
}

export function retireFocus(catalog, id, expected) {
  const normalized = normalizeFocusCatalog(catalog);
  const existing = findFocus(normalized, id);
  assertExpected(existing, expected);

  return {
    catalog: {
      foci: normalized.foci.filter((focus) => focus.id !== id),
      retiredFocusIds: [...new Set([...normalized.retiredFocusIds, id])],
    },
  };
}

export function addFocusNote(catalog, id, expected, note, now = new Date().toISOString()) {
  const normalized = normalizeFocusCatalog(catalog);
  const focus = findFocus(normalized, id);
  return updateFocus(
    normalized,
    id,
    expected,
    { notes: [...focus.notes, clean(note)].filter(Boolean) },
    now,
  );
}

export function createSubfocus(catalog, focusId, input, now = new Date().toISOString()) {
  const normalized = normalizeFocusCatalog(catalog);
  const existing = findFocus(normalized, focusId);
  const id = uniqueId(
    slugify(input?.name),
    existing.subfocuses.map((subfocus) => subfocus.id),
  );
  const subfocus = normalizeSubfocus({
    id,
    parentId: existing.id,
    name: clean(input?.name),
    goals: clean(input?.goals),
    scope: clean(input?.scope),
    constraints: clean(input?.constraints),
    planningDocs: cleanList(input?.planningDocs),
    refs: cleanList(input?.refs),
    notes: cleanList(input?.notes),
    activation: cleanActivation(input?.activation),
    createdAt: now,
    updatedAt: now,
    revision: 1,
  }, existing.id);
  const focus = {
    ...existing,
    subfocuses: [...existing.subfocuses, subfocus],
  };

  return {
    catalog: replaceFocus(normalized, focus),
    focus,
    subfocus,
  };
}

export function updateSubfocus(
  catalog,
  focusId,
  subfocusId,
  expected,
  input,
  now = new Date().toISOString(),
) {
  const normalized = normalizeFocusCatalog(catalog);
  const existingFocus = findFocus(normalized, focusId);
  const existing = findSubfocus(existingFocus, subfocusId);
  assertExpected(existing, expected);
  if (input?.activation !== undefined && !isRecord(input.activation)) {
    throw new Error("focus: invalid activation metadata");
  }

  const subfocus = normalizeSubfocus({
    ...existing,
    name: input?.name === undefined ? existing.name : clean(input.name),
    goals: input?.goals === undefined ? existing.goals : clean(input.goals),
    scope: input?.scope === undefined ? existing.scope : clean(input.scope),
    constraints: input?.constraints === undefined ? existing.constraints : clean(input.constraints),
    planningDocs: input?.planningDocs === undefined ? existing.planningDocs : cleanList(input.planningDocs),
    refs: input?.refs === undefined ? existing.refs : cleanList(input.refs),
    notes: input?.notes === undefined ? existing.notes : cleanList(input.notes),
    activation: input?.activation === undefined
      ? existing.activation
      : cleanActivation({ ...existing.activation, ...input.activation }),
    updatedAt: now,
    revision: existing.revision + 1,
  }, existingFocus.id);
  const focus = {
    ...existingFocus,
    subfocuses: existingFocus.subfocuses.map((item) =>
      item.id === subfocusId ? subfocus : item
    ),
  };

  return {
    catalog: replaceFocus(normalized, focus),
    focus,
    subfocus,
  };
}

export function addSubfocusNote(
  catalog,
  focusId,
  subfocusId,
  expected,
  note,
  now = new Date().toISOString(),
) {
  const normalized = normalizeFocusCatalog(catalog);
  const focus = findFocus(normalized, focusId);
  const subfocus = findSubfocus(focus, subfocusId);
  return updateSubfocus(
    normalized,
    focusId,
    subfocusId,
    expected,
    { notes: [...subfocus.notes, clean(note)].filter(Boolean) },
    now,
  );
}

export function findMatchingFoci(foci, query) {
  const needle = clean(query).toLowerCase();
  const exact = foci.filter((focus) =>
    focus.id.toLowerCase() === needle || focus.name.toLowerCase() === needle
  );
  const related = foci.filter((focus) => {
    if (exact.includes(focus)) return false;
    return [
      focus.id,
      focus.name,
      focus.goals,
      focus.scope,
      focus.constraints,
      ...(focus.planningDocs ?? []),
      ...(focus.refs ?? []),
      ...(focus.notes ?? []),
    ]
      .filter((value) => typeof value === "string")
      .some((value) => value.toLowerCase().includes(needle));
  });
  return [...exact, ...related.slice(0, 5)];
}

export function findFocusPath(catalog, focusId, subfocusId = null) {
  const normalized = normalizeFocusCatalog(catalog);
  const focus = findFocus(normalized, focusId);
  const subfocus = subfocusId === null ? null : findSubfocus(focus, subfocusId);
  return normalizeFocusPathSnapshot({
    focus: snapshotRecord(focus, "focus", null),
    subfocus: subfocus === null
      ? null
      : snapshotRecord(subfocus, "subfocus", focus.id),
  });
}

export function summarizeFocusPath(path) {
  const normalized = normalizeFocusPathSnapshot(path);
  const lines = [
    `Focus: ${normalized.focus.name}`,
    normalized.focus.goals ? `Goals: ${normalized.focus.goals}` : null,
    normalized.focus.scope ? `Scope: ${normalized.focus.scope}` : null,
    normalized.focus.constraints ? `Constraints: ${normalized.focus.constraints}` : null,
    normalized.focus.planningDocs.length
      ? `Planning docs: ${normalized.focus.planningDocs.join(", ")}`
      : null,
    normalized.focus.refs.length ? `Refs: ${normalized.focus.refs.join(", ")}` : null,
    normalized.focus.notes.length
      ? `Notes: ${normalized.focus.notes.slice(-5).join(" | ")}`
      : null,
  ].filter(Boolean);

  if (normalized.subfocus) {
    lines.push(`Subfocus: ${normalized.subfocus.name}`);
    if (normalized.subfocus.goals) {
      lines.push(`Subfocus goals: ${normalized.subfocus.goals}`);
    }
    if (normalized.subfocus.scope) {
      lines.push(`Subfocus scope: ${normalized.subfocus.scope}`);
    }
    if (normalized.subfocus.constraints) {
      lines.push(`Subfocus constraints: ${normalized.subfocus.constraints}`);
    }
  }

  return lines.join("\n");
}

function normalizeFocus(value) {
  if (!isRecord(value) || !validId(value.id) || !clean(value.name)) {
    throw new Error("focus: invalid catalog schema");
  }
  return omitUndefined({
    id: value.id,
    name: clean(value.name),
    goals: clean(value.goals),
    scope: clean(value.scope),
    constraints: clean(value.constraints),
    planningDocs: cleanList(value.planningDocs),
    refs: cleanList(value.refs),
    notes: cleanList(value.notes),
    activation: cleanActivation(value.activation),
    subfocuses: normalizeSubfocuses(value.subfocuses, value.id),
    createdAt: requiredString(value.createdAt, "createdAt"),
    updatedAt: requiredString(value.updatedAt, "updatedAt"),
    revision: positiveInteger(value.revision),
  });
}

function normalizeSubfocuses(value, focusId) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("focus: invalid catalog schema");
  return value.map((subfocus) => normalizeSubfocus(subfocus, focusId));
}

function normalizeSubfocus(value, focusId) {
  if (
    !isRecord(value)
    || !validId(value.id)
    || value.parentId !== focusId
    || !clean(value.name)
  ) {
    throw new Error("focus: invalid catalog schema");
  }
  return omitUndefined({
    id: value.id,
    parentId: value.parentId,
    name: clean(value.name),
    goals: clean(value.goals),
    scope: clean(value.scope),
    constraints: clean(value.constraints),
    planningDocs: cleanList(value.planningDocs),
    refs: cleanList(value.refs),
    notes: cleanList(value.notes),
    activation: cleanActivation(value.activation),
    createdAt: requiredString(value.createdAt, "createdAt"),
    updatedAt: requiredString(value.updatedAt, "updatedAt"),
    revision: positiveInteger(value.revision),
  });
}

function normalizeLegacyFocus(value) {
  if (!isRecord(value) || !validId(value.id) || !clean(value.name)) {
    throw new Error("focus: invalid state schema");
  }
  return omitUndefined({
    id: value.id,
    name: clean(value.name),
    goals: clean(value.goals),
    scope: clean(value.scope),
    constraints: clean(value.constraints),
    planningDocs: cleanList(value.planningDocs),
    refs: cleanList(value.refs),
    notes: cleanList(value.notes),
    activation: cleanActivation(value.activation),
    subfocuses: normalizeLegacySubfocuses(value.subfocuses),
    activeSubfocusId: nullableString(value.activeSubfocusId, "activeSubfocusId"),
    createdAt: nullableString(value.createdAt, "createdAt"),
    updatedAt: nullableString(value.updatedAt, "updatedAt"),
  });
}

function normalizeLegacySubfocuses(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("focus: invalid state schema");
  return value.map(normalizeLegacySubfocus);
}

function normalizeLegacySubfocus(value) {
  if (!isRecord(value) || !validId(value.id) || !clean(value.name)) {
    throw new Error("focus: invalid state schema");
  }
  return omitUndefined({
    id: value.id,
    name: clean(value.name),
    goals: clean(value.goals),
    scope: clean(value.scope),
    constraints: clean(value.constraints),
    planningDocs: cleanList(value.planningDocs),
    refs: cleanList(value.refs),
    notes: cleanList(value.notes),
    activation: cleanActivation(value.activation),
    createdAt: nullableString(value.createdAt, "createdAt"),
    updatedAt: nullableString(value.updatedAt, "updatedAt"),
  });
}

function findFocus(catalog, id) {
  const focus = catalog.foci.find((item) => item.id === id);
  if (!focus) throw new Error(`Unknown focus: ${id}`);
  return focus;
}

function findSubfocus(focus, id) {
  const subfocus = focus.subfocuses.find((item) => item.id === id);
  if (!subfocus) throw new Error(`Unknown subfocus: ${id}`);
  return subfocus;
}

function replaceFocus(catalog, replacement) {
  return {
    ...catalog,
    foci: catalog.foci.map((focus) =>
      focus.id === replacement.id ? replacement : focus
    ),
  };
}

function assertExpected(record, expected) {
  if (
    !isRecord(expected)
    || expected.createdAt !== record.createdAt
    || expected.revision !== record.revision
  ) {
    throw new Error("focus: stale catalog revision");
  }
}

function snapshotRecord(record, kind, parentId) {
  return omitUndefined({
    kind,
    id: record.id,
    parentId,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    revision: record.revision,
    goals: record.goals,
    scope: record.scope,
    constraints: record.constraints,
    planningDocs: record.planningDocs,
    refs: record.refs,
    notes: record.notes,
    activation: record.activation,
  });
}

const MAX_ID_LENGTH = 200;
const MAX_ACTIVATION_FIELD_LENGTH = 500;
const MAX_ACTIVATION_LIST_ITEMS = 8;
const MAX_TOOL_NAME_LENGTH = 200;
const MAX_TOOL_ITEMS = 128;

function cleanActivation(value) {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("focus: invalid activation metadata");

  const activation = {};
  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools) || value.tools.some((tool) => typeof tool !== "string")) {
      throw new Error("focus: invalid activation metadata");
    }
    activation.tools = value.tools
      .map((tool) => clean(tool).slice(0, MAX_TOOL_NAME_LENGTH))
      .filter(Boolean)
      .slice(0, MAX_TOOL_ITEMS);
  }
  if (value.loadoutPreset !== undefined) {
    if (typeof value.loadoutPreset !== "string") {
      throw new Error("focus: invalid activation metadata");
    }
    const loadoutPreset = bounded(value.loadoutPreset);
    if (loadoutPreset) activation.loadoutPreset = loadoutPreset;
  }
  for (const key of ["monitors", "scripts", "agents"]) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key]) || value[key].some((item) => typeof item !== "string")) {
      throw new Error("focus: invalid activation metadata");
    }
    activation[key] = value[key]
      .map(bounded)
      .filter(Boolean)
      .slice(0, MAX_ACTIVATION_LIST_ITEMS);
  }
  return Object.keys(activation).length ? activation : undefined;
}

function normalizeFocusIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((id) => !validId(id))) {
    throw new Error("focus: invalid catalog schema");
  }
  return [...new Set(value)];
}

function bounded(value) {
  return clean(value).slice(0, MAX_ACTIVATION_FIELD_LENGTH);
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value) {
    throw new Error(`focus: invalid ${name}`);
  }
  return value;
}

function nullableString(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`focus: invalid ${name}`);
  return value;
}

function positiveInteger(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("focus: invalid catalog revision");
  }
  return value;
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanList(value) {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  if (typeof value === "string") {
    return value.split(/[\n,]/).map(clean).filter(Boolean);
  }
  throw new Error("focus: invalid catalog schema");
}

function slugify(value) {
  const slug = clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "focus";
  return slug.slice(0, MAX_ID_LENGTH);
}

function uniqueId(base, existing) {
  const used = new Set(existing);
  if (!used.has(base)) return base;

  let count = 2;
  while (true) {
    const suffix = `-${count}`;
    const id = `${base.slice(0, MAX_ID_LENGTH - suffix.length)}${suffix}`;
    if (!used.has(id)) return id;
    count += 1;
  }
}

function validId(value) {
  return typeof value === "string"
    && value.length <= MAX_ID_LENGTH
    && /^[a-z0-9][a-z0-9-]*$/.test(value);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function omitUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}
