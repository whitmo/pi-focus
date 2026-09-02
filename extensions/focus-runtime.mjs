const MAX_FIELD_LENGTH = 500;
const MAX_LIST_ITEMS = 8;
const MAX_CONTEXT_LENGTH = 4_000;
const MAX_CONTAINER_CONTEXT_LENGTH = 1_500;
const MAX_PATH_CONTEXT_LENGTH = 650;
const MAX_ACTIVATION_CONTEXT_LENGTH = 800;
const MAX_GUARD_CONTEXT_LENGTH = 700;

export function activationCapabilities(registeredToolNames, activeToolNames = registeredToolNames) {
  const registeredTools = names(registeredToolNames);
  const activeTools = names(activeToolNames);
  const registered = new Set(registeredTools);
  const active = new Set(activeTools);
  const availableTools = registeredTools.filter((name) => active.has(name));
  return {
    registeredTools,
    activeTools,
    availableTools,
    loadoutProfile: capability("loadout_profile", registered, active),
    process: capability("process", registered, active),
    subagent: capability("subagent", registered, active),
  };
}

export function resolveToolPolicy(requested, registered, active) {
  if (requested === undefined) return null;

  const declared = [...new Set((requested ?? []).map(toolName).filter(Boolean))];
  const known = new Set((registered ?? []).map(toolName).filter(Boolean));
  const enabled = new Set((active ?? []).map(toolName).filter(Boolean));
  const allowed = declared.filter((name) => known.has(name) && enabled.has(name));
  return { declared, allowed, unavailable: declared.filter((name) => !allowed.includes(name)) };
}

export function effectiveToolDeclaration(path) {
  const declared = [path.focus.activation?.tools, path.subfocus?.activation?.tools]
    .filter((value) => value !== undefined);
  if (!declared.length) return undefined;
  return declared.reduce((left, right) => left.filter((name) => right.includes(name)));
}

export function resolvePathToolPolicy(path, registered, active) {
  return resolveToolPolicy(effectiveToolDeclaration(path), registered, active);
}

export function buildFocusContext(path, paths, capabilities) {
  const policy = resolvePathToolPolicy(
    path,
    capabilities?.registeredTools,
    capabilities?.activeTools,
  );
  const sections = [
    section("## Current Focus", [
      ...containerContext("Focus", path.focus),
      ...(path.subfocus ? containerContext("Subfocus", path.subfocus) : []),
    ], MAX_CONTAINER_CONTEXT_LENGTH),
    section("Focus paths (paths only; knowledge contents are not injected):", [
      ...containerPaths("Focus", paths.focus),
      ...(path.subfocus && paths.subfocus ? containerPaths("Subfocus", paths.subfocus) : []),
    ], MAX_PATH_CONTEXT_LENGTH),
    section("Activation declarations (inert):", [
      ...activationLines("Focus", path.focus.activation),
      ...(path.subfocus ? activationLines("Subfocus", path.subfocus.activation) : []),
    ], MAX_ACTIVATION_CONTEXT_LENGTH),
    section("Effective tool guard:", [
      `- Effective declared tools: ${policy === null ? "none" : list(policy.declared)}`,
      `- Active + registered: ${policy === null ? "no focus policy" : list(policy.allowed)}`,
      `- Unavailable by host policy: ${policy === null ? "none" : list(policy.unavailable)}`,
      "- Requires explicit invocation: declarations only guard currently active tools; they do not run loadouts, processes, scripts, or subagents.",
      `- Optional capability status: loadout_profile ${capabilityText(capabilities?.loadoutProfile)}, process ${capabilityText(capabilities?.process)}, subagent ${capabilityText(capabilities?.subagent)}.`,
    ], MAX_GUARD_CONTEXT_LENGTH),
  ];
  const context = sections.join("\n\n");
  if (context.length > MAX_CONTEXT_LENGTH) {
    throw new Error("focus: context budget exceeded");
  }
  return context;
}

function section(heading, lines, budget) {
  const values = lines.filter(Boolean);
  const lineLength = Math.floor((budget - values.length + 1) / values.length);
  return [heading, ...values.map((value) => compactLine(value, lineLength))].join("\n");
}

function compactLine(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function capability(name, registered, active) {
  if (!registered.has(name)) return { available: false, active: false, status: "unregistered/unavailable; requires explicit invocation" };
  if (!active.has(name)) return { available: true, active: false, status: "registered but inactive; available for explicit activation" };
  return { available: true, active: true, status: "active and registered; requires explicit invocation" };
}

function capabilityText(capability) {
  return capability?.status ?? "unregistered/unavailable; requires explicit invocation";
}

function containerContext(label, container) {
  const prefix = label.toLowerCase();
  return [
    `${label}: ${field(container.name)}`,
    `${label} captured revision: ${container.revision}`,
    projectField(`${prefix} goals`, container.goals),
    projectField(`${prefix} scope`, container.scope),
    projectField(`${prefix} constraints`, container.constraints),
    projectList(`${prefix} planning docs`, container.planningDocs),
    projectList(`${prefix} references`, container.refs),
    projectList(`${prefix} notes`, container.notes),
  ].filter(Boolean);
}

function containerPaths(label, paths) {
  return [
    `- ${label}: ${paths.container}`,
    `- ${label} knowledge base: ${paths.kb}`,
    `- ${label} state directory: ${paths.state}`,
  ];
}

function activationLines(label, activation = {}) {
  return [
    `- ${label} tools: ${activation.tools === undefined ? "none" : list(activation.tools)}`,
    `- ${label} loadout preset intent: ${field(activation.loadoutPreset) || "none"}`,
    `- ${label} monitor runbooks: ${list(activation.monitors)}`,
    `- ${label} script runbooks: ${list(activation.scripts)}`,
    `- ${label} agent runbooks: ${list(activation.agents)}`,
  ];
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

function names(values) {
  return [...new Set((values ?? []).map(toolName).filter(Boolean))];
}

function toolName(value) {
  return typeof value === "string" ? value : value?.name;
}
