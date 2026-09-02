import { parse, stringify } from "yaml";

export const FOCUS_BINDING_CUSTOM_TYPE = "pi-focus:binding";
export const SUBAGENT_BEFORE_CHILD_START = "subagents:before-child-start";
export const MAX_ID_LENGTH = 200;
export const MAX_FIELD_LENGTH = 500;
export const MAX_LIST_ITEMS = 8;
export const MAX_TOOL_ITEMS = 128;
export const MAX_TOOL_NAME_LENGTH = 200;
export const MAX_PATH_YAML_BYTES = 24_000;
export const MAX_TRANSFER_YAML_BYTES = 32_768;

const TRANSFER_OPEN = "<pi-focus-binding>";
const TRANSFER_CLOSE = "</pi-focus-binding>";
const INHERITED_TASK_PREFIX = "---\n# Your Task (below)\n";
const LOCAL_SOURCE = "local";
const TRANSFER_SOURCES = new Set(["parent-inherited", "parent-assigned"]);

export function restoreFocusBinding(entries) {
  if (!Array.isArray(entries)) return null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.customType !== FOCUS_BINDING_CUSTOM_TYPE) continue;
    try {
      return deepFreeze({
        entryId: id(entry.id),
        binding: normalizeBinding(entry.data),
      });
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
  return normalizeBinding({ ...input, version: 1, source: LOCAL_SOURCE, parent: undefined });
}

export function createTransferredFocusBinding(sessionId, transfer) {
  const normalized = normalizeTransfer(transfer);
  const active = normalized.active;
  return deepFreeze({
    version: 1,
    agentSessionId: id(sessionId),
    capturedAt: normalized.capturedAt,
    source: normalized.source,
    active,
    last: active,
    parent: { ...normalized.parent },
  });
}

export function createFocusTransfer(parent, source, active) {
  if (!isRecord(parent)) invalidTransfer();
  const binding = normalizeBinding(parent.binding);
  if (!TRANSFER_SOURCES.has(source)) invalidTransfer();
  return normalizeTransfer({
    version: 1,
    capturedAt: binding.capturedAt,
    source,
    active,
    parent: {
      sessionId: binding.agentSessionId,
      entryId: id(parent.entryId),
    },
  });
}

export function normalizeFocusPathSnapshot(value) {
  if (!isRecord(value)) invalidPath();
  const focus = normalizeContainer(value.focus, "focus");
  const subfocus = value.subfocus === null
    ? null
    : normalizeContainer(value.subfocus, "subfocus");
  if (subfocus !== null && subfocus.parentId !== focus.id) invalidPath();

  const snapshot = { focus, subfocus };
  if (byteLength(stringify(snapshot)) > MAX_PATH_YAML_BYTES) {
    throw new Error("focus: focus path is too large");
  }
  return deepFreeze(snapshot);
}

export function encodeFocusTransfer(transfer) {
  const normalized = normalizeTransfer(transfer);
  const yaml = stringify(normalized);
  assertTransferSize(yaml);
  return `${TRANSFER_OPEN}\n${yaml}${TRANSFER_CLOSE}\n`;
}

export function consumeInitialFocusTransfer(text) {
  if (typeof text !== "string") return null;
  const openLines = text.match(/^<pi-focus-binding>$/gm) ?? [];
  const closeLines = text.match(/^<\/pi-focus-binding>$/gm) ?? [];
  if (openLines.length > 1 || closeLines.length > 1) {
    throw new Error("focus: multiple focus transfer blocks");
  }

  const offset = text.startsWith(`${TRANSFER_OPEN}\n`)
    ? 0
    : text.startsWith(`${INHERITED_TASK_PREFIX}${TRANSFER_OPEN}\n`)
      ? INHERITED_TASK_PREFIX.length
      : -1;
  if (offset === -1) return null;
  if (openLines.length !== 1 || closeLines.length !== 1) invalidTransfer();

  const bodyStart = offset + TRANSFER_OPEN.length + 1;
  const closeStart = text.indexOf(`\n${TRANSFER_CLOSE}`, bodyStart);
  if (closeStart === -1) invalidTransfer();
  const afterClose = closeStart + 1 + TRANSFER_CLOSE.length;
  if (afterClose < text.length && text[afterClose] !== "\n") invalidTransfer();

  const yaml = text.slice(bodyStart, closeStart + 1);
  assertTransferSize(yaml);
  let value;
  try {
    value = parse(yaml);
  } catch {
    invalidTransfer();
  }
  const transfer = normalizeTransfer(value);
  const blockEnd = afterClose + (text[afterClose] === "\n" ? 1 : 0);
  return { text: text.slice(0, offset) + text.slice(blockEnd), transfer };
}

function normalizeBinding(value) {
  if (!isRecord(value) || value.version !== 1) invalidBinding();
  const source = value.source;
  if (source !== LOCAL_SOURCE && !TRANSFER_SOURCES.has(source)) invalidBinding();
  const parent = value.parent === undefined ? undefined : normalizeParent(value.parent);
  if ((source === LOCAL_SOURCE) !== (parent === undefined)) invalidBinding();

  return deepFreeze({
    version: 1,
    agentSessionId: id(value.agentSessionId),
    capturedAt: requiredField(value.capturedAt),
    source,
    active: nullablePath(value.active),
    last: nullablePath(value.last),
    ...(parent === undefined ? {} : { parent }),
  });
}

function normalizeTransfer(value) {
  if (!isRecord(value) || value.version !== 1 || !TRANSFER_SOURCES.has(value.source)) {
    invalidTransfer();
  }
  if ("agentSessionId" in value || "last" in value) invalidTransfer();
  const transfer = {
    version: 1,
    capturedAt: requiredField(value.capturedAt),
    source: value.source,
    active: nullablePath(value.active),
    parent: normalizeParent(value.parent),
  };
  assertTransferSize(stringify(transfer));
  return deepFreeze(transfer);
}

function normalizeParent(value) {
  if (!isRecord(value)) invalidBinding();
  return deepFreeze({ sessionId: id(value.sessionId), entryId: id(value.entryId) });
}

function nullablePath(value) {
  if (value === null) return null;
  return normalizeFocusPathSnapshot(value);
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

function assertTransferSize(value) {
  if (byteLength(value) > MAX_TRANSFER_YAML_BYTES) {
    throw new Error("focus: focus transfer is too large");
  }
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
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

function invalidTransfer() {
  throw new Error("focus: invalid focus transfer");
}
