const MAX_FIELD_LENGTH = 500;
const MAX_LIST_ITEMS = 8;
const MAX_CONTEXT_LENGTH = 4_000;

export function activationCapabilities(toolNames) {
  const availableTools = [...new Set((toolNames ?? []).map(toolName).filter(Boolean))];
  const available = new Set(availableTools);
  return {
    availableTools,
    loadoutProfile: capability("loadout_profile", available),
    process: capability("process", available),
    subagent: capability("subagent", available),
  };
}

export function restrictTools(baseline, requested, registered) {
  const original = [...new Set((baseline ?? []).map(toolName).filter(Boolean))];
  if (requested === undefined) return original;

  const allowed = new Set((requested ?? []).map(toolName).filter(Boolean));
  const known = new Set((registered ?? []).map(toolName).filter(Boolean));
  return original.filter((name) => allowed.has(name) && known.has(name));
}

export function buildFocusContext(focus, paths, capabilities) {
  const declared = focus.activation?.tools;
  const available = capabilities?.availableTools ?? [];
  const lines = [
    "## Current Focus",
    `Focus: ${field(focus.name)}`,
    projectField("goals", focus.goals),
    projectField("scope", focus.scope),
    projectField("constraints", focus.constraints),
    projectList("planning docs", focus.planningDocs),
    projectList("references", focus.refs),
    projectList("notes", focus.notes),
    "",
    "Focus paths (paths only; knowledge contents are not injected):",
    `- Focus: ${paths.focus}`,
    `- Knowledge base: ${paths.kb}`,
    `- State: ${paths.state}`,
    "",
    "Activation checklist:",
    `- Declared: ${declared === undefined ? "none" : list(declared)}`,
    `- Available: ${declared === undefined ? "baseline unchanged" : list(declared.filter((name) => available.includes(name)))}`,
    "- Requires explicit invocation: declarations only restrict available tools; they do not run loadouts, processes, subagents, reloads, discovery, or registration.",
    `- Optional capability status: loadout_profile ${capabilityText(capabilities?.loadoutProfile)}, process ${capabilityText(capabilities?.process)}, subagent ${capabilityText(capabilities?.subagent)}.`,
  ].filter(Boolean);
  const context = lines.join("\n");
  return context.length > MAX_CONTEXT_LENGTH ? `${context.slice(0, MAX_CONTEXT_LENGTH - 1)}…` : context;
}

function capability(name, available) {
  const isAvailable = available.has(name);
  return {
    available: isAvailable,
    status: isAvailable ? "available; requires explicit invocation" : "unavailable; requires explicit invocation",
  };
}

function capabilityText(capability) {
  return capability?.available ? "available (requires explicit invocation)" : "unavailable (requires explicit invocation)";
}

function projectField(label, value) {
  const text = field(value);
  return text ? `Project-provided ${label}: ${text}` : "";
}

function projectList(label, values) {
  const items = (values ?? []).slice(0, MAX_LIST_ITEMS).map(field).filter(Boolean);
  return items.length ? `Project-provided ${label}: ${items.join(", ")}` : "";
}

function list(values) {
  const items = (values ?? []).slice(0, MAX_LIST_ITEMS).map(field).filter(Boolean);
  return items.length ? items.join(", ") : "none";
}

function field(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > MAX_FIELD_LENGTH ? `${text.slice(0, MAX_FIELD_LENGTH - 1)}…` : text;
}

function toolName(value) {
  return typeof value === "string" ? value : value?.name;
}
