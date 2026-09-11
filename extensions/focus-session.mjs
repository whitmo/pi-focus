import { stringify } from "yaml";

export const FOCUS_BINDING_CUSTOM_TYPE = "pi-focus:binding";

const MAX_ID_LENGTH = 200;
const MAX_FIELD_LENGTH = 500;
const MAX_LIST_ITEMS = 8;
const MAX_TOOL_ITEMS = 128;
const MAX_TOOL_NAME_LENGTH = 200;
const MAX_PATH_YAML_BYTES = 24_000;

export function restoreFocusBinding(entries) {
  if (!Array.isArray(entries)) return null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.customType !== FOCUS_BINDING_CUSTOM_TYPE) continue;
    try {
      return deepFreeze({ entryId: id(entry.id), binding: normalizeBinding(entry.data) });
    } catch {
      return null;
    }
  }
  return null;
}

export function focusBindingIds(binding) {
  try {
    const normalized = normalizeBinding(binding);
    return normalized.active === null
      ? null
      : { focusId: normalized.active.focus.id, subfocusId: normalized.active.subfocus?.id ?? null };
  } catch {
    return null;
  }
}

export function createLocalFocusBinding(input) {
  if (!isRecord(input)) invalidBinding();
  return normalizeBinding({
    version: 1,
    agentSessionId: input.agentSessionId,
    capturedAt: input.capturedAt,
    source: "local",
    active: input.active,
    last: input.last,
  });
}

export function createForkedFocusBinding(sessionId, sourceEntry) {
  if (!isRecord(sourceEntry)) invalidBinding();
  const source = normalizeBinding(sourceEntry.binding);
  return normalizeBinding({
    version: 1,
    agentSessionId: sessionId,
    capturedAt: source.capturedAt,
    source: "fork",
    active: source.active,
    last: source.last,
    forkedFrom: { sessionId: source.agentSessionId, entryId: sourceEntry.entryId },
  });
}

export function normalizeFocusPathSnapshot(value) {
  if (!isRecord(value)) invalidPath();
  const focus = normalizeContainer(value.focus, "focus");
  const subfocus = value.subfocus === null ? null : normalizeContainer(value.subfocus, "subfocus");
  if (subfocus !== null && subfocus.parentId !== focus.id) invalidPath();

  const snapshot = { focus, subfocus };
  if (Buffer.byteLength(stringify(snapshot), "utf8") > MAX_PATH_YAML_BYTES) {
    throw new Error("focus: focus path is too large");
  }
  return deepFreeze(snapshot);
}

function normalizeBinding(value) {
  if (!isRecord(value) || value.version !== 1) invalidBinding();
  if (value.source !== "local" && value.source !== "fork") invalidBinding();
  const forkedFrom = value.forkedFrom === undefined ? undefined : normalizeForkedFrom(value.forkedFrom);
  if ((value.source === "local") !== (forkedFrom === undefined)) invalidBinding();

  return deepFreeze({
    version: 1,
    agentSessionId: id(value.agentSessionId),
    capturedAt: requiredField(value.capturedAt),
    source: value.source,
    active: nullablePath(value.active),
    last: nullablePath(value.last),
    ...(forkedFrom === undefined ? {} : { forkedFrom }),
  });
}

function normalizeForkedFrom(value) {
  if (!isRecord(value)) invalidBinding();
  return deepFreeze({ sessionId: id(value.sessionId), entryId: id(value.entryId) });
}

function nullablePath(value) {
  return value === null ? null : normalizeFocusPathSnapshot(value);
}

function normalizeContainer(value, expectedKind) {
  if (!isRecord(value) || value.kind !== expectedKind) invalidPath();
  const parentId = expectedKind === "focus"
    ? value.parentId === null ? null : invalidPath()
    : id(value.parentId);
  const container = {
    kind: expectedKind,
    id: id(value.id),
    parentId,
    name: requiredField(value.name),
    createdAt: requiredField(value.createdAt),
    updatedAt: requiredField(value.updatedAt),
    revision: positiveInteger(value.revision),
    goals: field(value.goals),
    scope: field(value.scope),
    constraints: field(value.constraints),
    planningDocs: list(value.planningDocs),
    refs: list(value.refs),
    notes: list(value.notes),
  };
  if (value.activation !== undefined) container.activation = normalizeActivation(value.activation);
  return deepFreeze(container);
}

function normalizeActivation(value) {
  if (!isRecord(value)) invalidPath();
  const activation = {};
  if (value.tools !== undefined) activation.tools = list(value.tools, MAX_TOOL_ITEMS, MAX_TOOL_NAME_LENGTH);
  if (value.loadoutPreset !== undefined) activation.loadoutPreset = field(value.loadoutPreset);
  for (const key of ["monitors", "scripts", "agents"]) {
    if (value[key] !== undefined) activation[key] = list(value[key]);
  }
  return deepFreeze(activation);
}

function list(value, maxItems = MAX_LIST_ITEMS, maxLength = MAX_FIELD_LENGTH) {
  if (!Array.isArray(value) || value.length > maxItems) invalidPath();
  return Object.freeze(value.map((item) => boundedString(item, maxLength)));
}

function field(value) {
  return boundedString(value, MAX_FIELD_LENGTH);
}

function requiredField(value) {
  const normalized = field(value);
  if (normalized.length === 0) invalidBinding();
  return normalized;
}

function id(value) {
  if (
    typeof value !== "string"
    || value.length > MAX_ID_LENGTH
    || !/^[a-z0-9][a-z0-9-]*$/.test(value)
  ) {
    invalidPath();
  }
  return value;
}

function positiveInteger(value) {
  if (!Number.isInteger(value) || value < 1) invalidPath();
  return value;
}

function boundedString(value, maxLength) {
  if (typeof value !== "string" || [...value].length > maxLength) invalidPath();
  return value;
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidBinding() {
  throw new Error("focus: invalid focus binding");
}

function invalidPath() {
  throw new Error("focus: invalid focus path");
}
