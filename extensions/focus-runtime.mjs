import { relative } from "node:path";

const MAX_FIELD_LENGTH = 500;
const MAX_LIST_ITEMS = 8;
const MAX_CONTEXT_LENGTH = 4_000;
const MAX_COMPACT_NAME_LENGTH = 200;
const MAX_COMPACT_ROOT_LENGTH = 500;
const MAX_COMPACT_PATH_LENGTH = 250;

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
  const options = [
    {},
    { compactProse: true },
    { compactProse: true, compactDeclarations: true },
    { compactProse: true, compactDeclarations: true, compactPaths: true },
  ];
  for (const option of options) {
    const context = renderContext(path, paths, capabilities, policy, option);
    if (context.length <= MAX_CONTEXT_LENGTH) return context;
  }
  throw new Error("focus: context budget exceeded");
}

function renderContext(path, paths, capabilities, policy, options) {
  const container = options.compactProse ? compactContainerContext : containerContext;
  const activation = options.compactDeclarations ? compactActivationLines : activationLines;
  const guard = options.compactDeclarations ? compactGuardLines : guardLines;
  return [
    section("## Current Focus", [
      ...container("Focus", path.focus),
      ...(path.subfocus ? container("Subfocus", path.subfocus) : []),
    ]),
    section("Focus paths (paths only; knowledge contents are not injected):",
      options.compactPaths
        ? compactContainerPaths(paths, Boolean(path.subfocus))
        : [
            ...containerPaths("Focus", paths.focus),
            ...(path.subfocus && paths.subfocus ? containerPaths("Subfocus", paths.subfocus) : []),
          ]),
    section("Activation declarations (inert):", [
      ...activation("Focus", path.focus.activation),
      ...(path.subfocus ? activation("Subfocus", path.subfocus.activation) : []),
    ]),
    section("Effective tool guard:", guard(policy, capabilities)),
  ].join("\n\n");
}

function section(heading, lines) {
  return [heading, ...lines.filter(Boolean)].join("\n");
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

function compactContainerContext(label, container) {
  const values = [
    container.goals,
    container.scope,
    container.constraints,
    ...(container.planningDocs ?? []),
    ...(container.refs ?? []),
    ...(container.notes ?? []),
  ];
  return [
    compactLine(`${label}: ${field(container.name)}`, MAX_COMPACT_NAME_LENGTH),
    `${label} captured revision: ${container.revision}`,
    values.some((value) => field(value))
      ? `Project-provided ${label.toLowerCase()} context: omitted to fit ${MAX_CONTEXT_LENGTH.toLocaleString("en-US")} characters.`
      : "",
  ].filter(Boolean);
}

function containerPaths(label, paths) {
  return [
    `- ${label}: ${paths.container}`,
    `- ${label} knowledge base: ${paths.kb}`,
    `- ${label} state directory: ${paths.state}`,
  ];
}

function compactContainerPaths(paths, includeSubfocus) {
  const root = paths.focus.container;
  const relativePath = (value) => compactPath(relative(root, value) || ".", MAX_COMPACT_PATH_LENGTH);
  return [
    `- Shared absolute root: ${compactPath(root, MAX_COMPACT_ROOT_LENGTH)}`,
    `- Focus container: ${relativePath(paths.focus.container)}`,
    `- Focus knowledge base: ${relativePath(paths.focus.kb)}`,
    `- Focus state directory: ${relativePath(paths.focus.state)}`,
    ...(includeSubfocus && paths.subfocus
      ? [
          `- Subfocus container: ${relativePath(paths.subfocus.container)}`,
          `- Subfocus knowledge base: ${relativePath(paths.subfocus.kb)}`,
          `- Subfocus state directory: ${relativePath(paths.subfocus.state)}`,
        ]
      : []),
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

function compactActivationLines(label, activation = {}) {
  return [
    `- ${label} tools: ${count(activation.tools, "tool")}`,
    `- ${label} loadout preset intent: ${activation.loadoutPreset ? "set" : "none"}`,
    `- ${label} monitor runbooks: ${count(activation.monitors, "runbook")}`,
    `- ${label} script runbooks: ${count(activation.scripts, "runbook")}`,
    `- ${label} agent runbooks: ${count(activation.agents, "runbook")}`,
  ];
}

function guardLines(policy, capabilities) {
  return [
    `- Effective declared tools: ${policy === null ? "none" : list(policy.declared)}`,
    `- Active + registered: ${policy === null ? "no focus policy" : list(policy.allowed)}`,
    `- Unavailable by host policy: ${policy === null ? "none" : list(policy.unavailable)}`,
    "- Requires explicit invocation: declarations only guard currently active tools; they do not run loadouts, processes, scripts, or subagents.",
    `- Optional capability status: loadout_profile ${capabilityText(capabilities?.loadoutProfile)}, process ${capabilityText(capabilities?.process)}, subagent ${capabilityText(capabilities?.subagent)}.`,
  ];
}

function compactGuardLines(policy, capabilities) {
  return [
    `- Effective declared tools: ${policy === null ? "none" : count(policy.declared, "tool")}`,
    `- Active + registered: ${policy === null ? "no focus policy" : count(policy.allowed, "tool")}`,
    `- Unavailable by host policy: ${policy === null ? "none" : count(policy.unavailable, "tool")}`,
    ...guardLines(null, capabilities).slice(3),
  ];
}

function compactLine(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function compactPath(value, maxLength) {
  if (value.length <= maxLength) return value;
  const left = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, left)}…${value.slice(value.length - (maxLength - left - 1))}`;
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
  const items = (values ?? []).map(field).filter(Boolean);
  return items.length ? items.join(", ") : "none";
}

function count(values, singular) {
  const total = values?.length ?? 0;
  return total ? `${total} ${singular}${total === 1 ? "" : "s"}` : "none";
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
