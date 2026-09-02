import { fileURLToPath } from "node:url";
import { join } from "node:path";

type ToolInfo = { name: string };
type AutocompleteItem = { value: string; label: string };

type FocusPath = {
  focus: { id: string; name: string; createdAt: string; revision: number; activation?: FocusActivation };
  subfocus: { id: string; createdAt: string; revision: number; activation?: FocusActivation } | null;
};

type FocusBindingV1 = {
  version: 1;
  agentSessionId: string;
  capturedAt: string;
  source: "local" | "fork";
  active: FocusPath | null;
  last: FocusPath | null;
};

type FocusActivation = {
  tools?: string[];
  loadoutPreset?: string;
  monitors?: string[];
  scripts?: string[];
  agents?: string[];
};

type SessionManager = {
  getSessionId: () => string;
  getBranch: () => unknown[];
};

type CommandContext = {
  cwd: string;
  hasUI: boolean;
  sessionManager: SessionManager;
  isIdle?: () => boolean;
  waitForIdle?: () => Promise<void>;
  ui: {
    input: (title: string, placeholder?: string) => Promise<string | undefined>;
    editor: (title: string, initial?: string) => Promise<string | undefined>;
    select: (title: string, options: string[]) => Promise<string | undefined>;
    notify: (message: string, level?: "info" | "warning" | "error") => void;
    setStatus: (key: string, value: string | undefined) => void;
    setTitle?: (title: string) => void;
    theme: { fg: (color: string, text: string) => string };
  };
};

type FocusCommand = {
  description: string;
  getArgumentCompletions: (prefix: string) => AutocompleteItem[] | null;
  handler: (args: string, ctx: CommandContext) => Promise<void>;
};

type ExtensionAPI = {
  on: (event: string, handler: (...args: any[]) => unknown) => void;
  registerCommand: (name: string, command: FocusCommand) => void;
  appendEntry: (customType: string, data: unknown) => void;
  sendUserMessage?: (message: string, options?: { deliverAs: "followUp" }) => void;
  getActiveTools?: () => string[];
  getAllTools?: () => ToolInfo[];
};

// @ts-ignore JavaScript helpers keep the extension testable with node:test.
import {
  addFocusNote,
  createFocus,
  createSubfocus,
  findFocusPath,
  findMatchingFoci,
  retireFocus,
  updateFocus,
  updateSubfocus,
} from "./focus-core.mjs";
// @ts-ignore JavaScript helpers keep the extension testable with node:test.
import {
  deleteKnowledgeEntry,
  ensureContainerDirectories,
  focusDirectory,
  listKnowledgeEntries,
  loadFocusCatalog,
  readKnowledgeEntry,
  subfocusDirectory,
  updateFocusCatalog,
  writeKnowledgeEntry,
} from "./focus-store.mjs";
// @ts-ignore JavaScript helpers keep the extension testable with node:test.
import {
  activationCapabilities,
  buildFocusContext,
  resolvePathToolPolicy,
} from "./focus-runtime.mjs";
// @ts-ignore JavaScript helpers keep the extension testable with node:test.
import {
  FOCUS_BINDING_CUSTOM_TYPE,
  createForkedFocusBinding,
  createLocalFocusBinding,
  restoreFocusBinding,
} from "./focus-session.mjs";

const SKILL_PARENT = fileURLToPath(new URL("../skills", import.meta.url));
const SUBCOMMANDS = ["new", "edit", "delete", "kb", "on", "expand", "narrow", "off", "status", "use", "help"];

export default function focusExtension(pi: ExtensionAPI): void {
  let current: { entryId: string; binding: FocusBindingV1 } | null = null;
  let sessionCwd = process.cwd();

  const registeredTools = (): string[] => pi.getAllTools?.().map((tool) => tool.name) ?? [];
  const activeTools = (): string[] => pi.getActiveTools?.() ?? [];
  const capabilities = () => activationCapabilities(registeredTools(), activeTools());

  const appendAndReconcile = (ctx: CommandContext, binding: FocusBindingV1): void => {
    try {
      pi.appendEntry(FOCUS_BINDING_CUSTOM_TYPE, binding);
    } catch (error) {
      ctx.ui.notify(`focus: binding persistence failed: ${(error as Error).message}`, "warning");
    }
    current = restoreFocusBinding(ctx.sessionManager.getBranch());
    updateFocusStatus(ctx, current?.binding.active ?? null, capabilities());
  };

  const appendLocal = (ctx: CommandContext, active: FocusPath | null, last: FocusPath | null = active): void => {
    appendAndReconcile(ctx, createLocalFocusBinding({
      agentSessionId: ctx.sessionManager.getSessionId(),
      capturedAt: new Date().toISOString(),
      active,
      last,
    }));
  };

  const bindPath = (ctx: CommandContext, path: FocusPath, steer: boolean): void => {
    appendLocal(ctx, path);
    if (steer) sendFocusMessage(pi, ctx, `Return to this focus and keep the next answer centered on it:\n\n${path.focus.name}`);
  };

  const bindCatalogFocus = (ctx: CommandContext, focusId: string, subfocusId: string | null = null, steer = true): void => {
    const path = findFocusPath(loadFocusCatalog(sessionCwd), focusId, subfocusId) as FocusPath;
    bindPath(ctx, path, steer);
  };

  pi.on("session_start", async (event, ctx: CommandContext) => {
    sessionCwd = ctx.cwd;
    if (event.reason === "reload") {
      current = restoreFocusBinding(ctx.sessionManager.getBranch());
      updateFocusStatus(ctx, current?.binding.active ?? null, capabilities());
      return;
    }

    if (event.reason === "fork") {
      const source = restoreFocusBinding(ctx.sessionManager.getBranch());
      if (source) {
        appendAndReconcile(ctx, createForkedFocusBinding(ctx.sessionManager.getSessionId(), source));
      } else {
        appendLocal(ctx, null, null);
      }
      return;
    }

    current = null;
    appendLocal(ctx, null, null);
    if (ctx.hasUI) await handleChooser(ctx, bindCatalogFocus, "", capabilities());
  });

  pi.on("session_tree", (_event, ctx: CommandContext) => {
    if (current) appendAndReconcile(ctx, current.binding);
  });

  pi.on("session_shutdown", (_event, _ctx: CommandContext) => {
    current = null;
    sessionCwd = process.cwd();
  });

  pi.on("resources_discover", () => ({ skillPaths: [SKILL_PARENT] }));

  pi.on("context", (event, ctx: CommandContext) => {
    const active = current?.binding.active;
    if (!active) return { messages: [...event.messages] };
    const text = buildFocusContext(active, focusPaths(sessionCwd, active), capabilities());
    return {
      messages: [
        ...event.messages,
        {
          role: "custom",
          customType: "focus-context",
          content: [{ type: "text", text }],
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });

  pi.on("tool_call", (event, _ctx: CommandContext) => {
    const active = current?.binding.active;
    const policy = active ? resolvePathToolPolicy(active, registeredTools(), activeTools()) : null;
    if (!policy || policy.allowed.includes(event.toolName)) return;
    if (!policy.declared.includes(event.toolName)) {
      return { block: true, reason: `focus: ${event.toolName} is not declared by the active focus` };
    }
    if (!registeredTools().includes(event.toolName)) {
      return { block: true, reason: `focus: ${event.toolName} is declared but not registered` };
    }
    return { block: true, reason: `focus: ${event.toolName} is declared but not active` };
  });

  pi.registerCommand("focus", {
    description: "Set and steer current work focus — use new | edit | delete | kb | on | expand | narrow | off | status",
    getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
      const query = prefix.trimStart();
      if (query.startsWith("use ")) {
        const needle = query.slice(4).toLowerCase();
        try {
          const matches = loadFocusCatalog(sessionCwd).foci
            .filter((focus) => focus.id.startsWith(needle))
            .map((focus) => ({ value: `use ${focus.id}`, label: `use ${focus.id}` }));
          return matches.length ? matches : null;
        } catch {
          return null;
        }
      }
      const matches = SUBCOMMANDS
        .filter((command) => command.startsWith(query))
        .map((command) => ({ value: command, label: command }));
      return matches.length ? matches : null;
    },
    handler: async (args: string, ctx: CommandContext): Promise<void> => {
      const [sub = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const requiresUI = !["off", "status", "use", "on", "help"].includes(sub);
      if (!ctx.hasUI && requiresUI) {
        ctx.ui.notify("focus: interactive focus management is unavailable in this host", "warning");
        return;
      }
      if (!sub) {
        await handleChooser(ctx, bindCatalogFocus, "", capabilities());
      } else if (sub === "new") {
        await handleNew(ctx, bindPath);
      } else if (sub === "on") {
        const last = current?.binding.last;
        if (!last) {
          ctx.ui.notify("focus: no previous focus; run /focus use", "warning");
          return;
        }
        appendLocal(ctx, last, last);
        sendFocusMessage(pi, ctx, `Return to this focus and keep the next answer centered on it:\n\n${last.focus.name}`);
      } else if (sub === "expand") {
        await handleExpand(ctx, bindPath);
      } else if (sub === "narrow") {
        await handleNarrow(ctx, bindPath);
      } else if (sub === "off") {
        appendLocal(ctx, null, current?.binding.last ?? current?.binding.active ?? null);
        ctx.ui.notify("focus: off", "info");
      } else if (sub === "status") {
        handleStatus(ctx, current?.binding.active ?? null, capabilities());
      } else if (sub === "edit") {
        await handleEdit(ctx, current?.binding.active ?? null, bindPath, capabilities());
      } else if (sub === "delete") {
        await handleDelete(ctx, current?.binding.active ?? null, appendAndReconcile, capabilities());
      } else if (sub === "kb") {
        await handleKnowledgeBase(ctx, current?.binding.active ?? null);
      } else if (sub === "use") {
        await handleUse(ctx, rest.join(" "), bindCatalogFocus);
      } else if (sub === "help") {
        ctx.ui.notify(focusHelp(), "info");
      } else {
        await handleChooser(ctx, bindCatalogFocus, [sub, ...rest].join(" "), capabilities());
      }
    },
  });
}

type BindCatalogFocus = (ctx: CommandContext, focusId: string, subfocusId?: string | null, steer?: boolean) => void;
type BindPath = (ctx: CommandContext, path: FocusPath, steer: boolean) => void;
type AppendAndReconcile = (ctx: CommandContext, binding: FocusBindingV1) => void;

async function handleChooser(ctx: CommandContext, bindCatalogFocus: BindCatalogFocus, query = "", capabilities?: ReturnType<typeof activationCapabilities>): Promise<void> {
  const catalog = loadFocusCatalog(ctx.cwd);
  const matches = query ? findMatchingFoci(catalog.foci, query) : [];
  const options = query
    ? [
        ...matches.map((focus) => `${focus.id.toLowerCase() === query.toLowerCase() || focus.name.toLowerCase() === query.toLowerCase() ? "Use exact" : "Use related"} focus “${focus.name}” (${focus.id})`),
        `Create new focus “${query}”`,
      ]
    : ["View info on current focus", "Switch to a past/existing focus", "Create a new focus"];
  const selected = await ctx.ui.select(query ? `Focus matches for “${query}”` : "Focus", options);
  if (!selected) return;
  if (!query) {
    if (selected === options[0]) return handleStatus(ctx, null, capabilities);
    if (selected === options[1]) return handleSwitch(ctx, bindCatalogFocus);
    return handleNew(ctx, (commandCtx, path, steer) => bindCatalogFocus(commandCtx, path.focus.id, path.subfocus?.id ?? null, steer));
  }
  if (selected.startsWith("Create new focus")) {
    return handleNew(ctx, (commandCtx, path, steer) => bindCatalogFocus(commandCtx, path.focus.id, path.subfocus?.id ?? null, steer), query);
  }
  const focus = matches[options.indexOf(selected)];
  if (focus) bindCatalogFocus(ctx, focus.id, null, true);
}

async function handleSwitch(ctx: CommandContext, bindCatalogFocus: BindCatalogFocus): Promise<void> {
  const foci = loadFocusCatalog(ctx.cwd).foci;
  if (!foci.length) {
    ctx.ui.notify("focus: no existing foci; run /focus new", "warning");
    return;
  }
  const options = foci.map((focus) => `${focus.name} (${focus.id})`);
  const selected = await ctx.ui.select("Switch focus", options);
  const focus = foci[options.indexOf(selected ?? "")];
  if (focus) bindCatalogFocus(ctx, focus.id, null, true);
}

async function handleNew(ctx: CommandContext, bindPath: BindPath, suppliedName?: string): Promise<void> {
  const name = suppliedName ?? await ctx.ui.input("Focus name", "e.g. Release planning");
  if (!name?.trim()) return;
  const goals = await ctx.ui.editor("Goals", "What are we trying to accomplish?");
  const scope = await ctx.ui.editor("Scope", "What is in bounds?");
  const constraints = await ctx.ui.editor("Constraints", "What must stay true?");
  const planningDocs = await ctx.ui.editor("Planning docs", "One path or URL per line");
  const refs = await ctx.ui.editor("Tickets, PRs, repos", "One reference per line");
  const result = updateFocusCatalog(ctx.cwd, (catalog) => createFocus(catalog, { name, goals, scope, constraints, planningDocs, refs }));
  ensureContainerDirectories(ctx.cwd, result.focus.id);
  bindPath(ctx, findFocusPath(result.catalog, result.focus.id), true);
}

async function handleExpand(ctx: CommandContext, bindPath: BindPath): Promise<void> {
  const active = activePath(ctx);
  if (!active) return;
  const note = await ctx.ui.editor("Add focus data", "Paste notes, docs, tickets, PRs, repos, or constraints");
  if (!note?.trim()) return;
  try {
    const result = updateFocusCatalog(ctx.cwd, (catalog) => addFocusNote(
      catalog,
      active.focus.id,
      expected(active.focus),
      note,
    ));
    bindPath(ctx, findFocusPath(result.catalog, active.focus.id, active.subfocus?.id ?? null), false);
    ctx.ui.notify("focus: added note", "info");
  } catch (error) {
    ctx.ui.notify(`focus: ${(error as Error).message}`, "warning");
  }
}

async function handleNarrow(ctx: CommandContext, bindPath: BindPath): Promise<void> {
  const active = activePath(ctx);
  if (!active) return;
  const name = await ctx.ui.input("Subfocus name", "e.g. PR review");
  if (!name?.trim()) return;
  const goals = await ctx.ui.editor("Subfocus goals", "What is the narrower target?");
  const scope = await ctx.ui.editor("Subfocus scope", "What is in bounds for this slice?");
  const constraints = await ctx.ui.editor("Subfocus constraints", "What should not change?");
  try {
    const result = updateFocusCatalog(ctx.cwd, (catalog) => createSubfocus(
      catalog,
      active.focus.id,
      { name, goals, scope, constraints },
    ));
    ensureContainerDirectories(ctx.cwd, active.focus.id, result.subfocus.id);
    bindPath(ctx, findFocusPath(result.catalog, active.focus.id, result.subfocus.id), true);
  } catch (error) {
    ctx.ui.notify(`focus: ${(error as Error).message}`, "warning");
  }
}

async function handleUse(ctx: CommandContext, idOrName: string, bindCatalogFocus: BindCatalogFocus): Promise<void> {
  const query = idOrName.trim().toLowerCase();
  const focus = loadFocusCatalog(ctx.cwd).foci.find((item) => item.id === query || item.name.toLowerCase() === query);
  if (!focus) {
    ctx.ui.notify(`focus: unknown focus ${idOrName || "(empty)"}`, "warning");
    return;
  }
  bindCatalogFocus(ctx, focus.id, null, true);
}

async function handleEdit(ctx: CommandContext, active: FocusPath | null, bindPath: BindPath, capabilities: ReturnType<typeof activationCapabilities>): Promise<void> {
  if (!active) {
    ctx.ui.notify("focus: no active focus to edit", "warning");
    return;
  }
  const fields = ["Goals", "Scope", "Constraints", "Planning docs", "Refs", "Tool declarations", "Loadout preset", "Monitor declarations", "Script declarations", "Agent declarations"];
  const field = await ctx.ui.select("Edit focus", fields);
  if (!field) return;
  const target = active.subfocus ?? active.focus;
  const key = field === "Planning docs" ? "planningDocs" : field === "Refs" ? "refs" : field.toLowerCase();
  const activationKey = ({
    "Tool declarations": "tools",
    "Loadout preset": "loadoutPreset",
    "Monitor declarations": "monitors",
    "Script declarations": "scripts",
    "Agent declarations": "agents",
  } as Record<string, keyof FocusActivation>)[field];
  const initial = activationKey === "loadoutPreset"
    ? target.activation?.loadoutPreset ?? ""
    : activationKey
      ? (target.activation?.[activationKey] ?? []).join("\n")
      : String((target as Record<string, unknown>)[key] ?? "");
  const value = await ctx.ui.editor(field, initial);
  if (value === undefined) return;
  const input = activationKey
    ? { activation: { [activationKey]: activationKey === "loadoutPreset" ? value : value.split(/[\n,]/) } }
    : { [key]: value };
  try {
    const result = updateFocusCatalog(ctx.cwd, (catalog) => active.subfocus
      ? updateSubfocus(catalog, active.focus.id, active.subfocus.id, expected(active.subfocus), input)
      : updateFocus(catalog, active.focus.id, expected(active.focus), input));
    bindPath(ctx, findFocusPath(result.catalog, active.focus.id, active.subfocus?.id ?? null), false);
    updateFocusStatus(ctx, activePath(ctx), capabilities);
    ctx.ui.notify(`focus: updated ${field.toLowerCase()}`, "info");
  } catch (error) {
    ctx.ui.notify(`focus: ${(error as Error).message}`, "warning");
  }
}

async function handleDelete(ctx: CommandContext, active: FocusPath | null, appendAndReconcile: AppendAndReconcile, capabilities: ReturnType<typeof activationCapabilities>): Promise<void> {
  const catalog = loadFocusCatalog(ctx.cwd);
  if (!catalog.foci.length) {
    ctx.ui.notify("focus: no foci to delete", "warning");
    return;
  }
  const options = catalog.foci.map((focus) => `${focus.name} (${focus.id})`);
  const selected = await ctx.ui.select("Delete focus", options);
  const focus = catalog.foci[options.indexOf(selected ?? "")];
  if (!focus) return;
  const confirmed = await ctx.ui.select(`Delete “${focus.name}”?`, ["Cancel", `Delete “${focus.name}”`]);
  if (confirmed !== `Delete “${focus.name}”`) return;
  try {
    updateFocusCatalog(ctx.cwd, (current) => retireFocus(current, focus.id, expected(focus)));
  } catch (error) {
    ctx.ui.notify(`focus: ${(error as Error).message}`, "warning");
    return;
  }

  if (active?.focus.id === focus.id) {
    appendAndReconcile(ctx, createLocalFocusBinding({
      agentSessionId: ctx.sessionManager.getSessionId(),
      capturedAt: new Date().toISOString(),
      active: null,
      last: null,
    }));
  }
  updateFocusStatus(ctx, active?.focus.id === focus.id ? null : active, capabilities);
  ctx.ui.notify(`focus: deleted ${focus.name}`, "info");
}

async function handleKnowledgeBase(ctx: CommandContext, active: FocusPath | null): Promise<void> {
  if (!active) {
    ctx.ui.notify("focus: no active focus knowledge base", "warning");
    return;
  }
  const focusId = active.focus.id;
  const subfocusId = active.subfocus?.id ?? null;
  const entries = listKnowledgeEntries(ctx.cwd, focusId, subfocusId);
  const selected = await ctx.ui.select("Focus knowledge base", [...entries, "Create new entry"]);
  if (!selected) return;
  if (selected === "Create new entry") {
    const name = await ctx.ui.input("Knowledge entry name", "e.g. plan");
    if (!name?.trim()) return;
    const content = await ctx.ui.editor("Knowledge entry", "");
    if (content === undefined) return;
    writeKnowledgeEntry(ctx.cwd, focusId, name, content, subfocusId);
    ctx.ui.notify("focus: knowledge entry saved", "info");
    return;
  }
  const action = await ctx.ui.select(`Knowledge: ${selected}`, ["Edit entry", "Delete entry"]);
  if (action === "Edit entry") {
    const content = await ctx.ui.editor(`Knowledge: ${selected}`, readKnowledgeEntry(ctx.cwd, focusId, selected, subfocusId));
    if (content === undefined) return;
    writeKnowledgeEntry(ctx.cwd, focusId, selected, content, subfocusId);
    ctx.ui.notify("focus: knowledge entry saved", "info");
    return;
  }
  if (action === "Delete entry") {
    const confirmed = await ctx.ui.select(`Delete “${selected}”?`, ["Cancel", `Delete “${selected}”`]);
    if (confirmed !== `Delete “${selected}”`) return;
    deleteKnowledgeEntry(ctx.cwd, focusId, selected, subfocusId);
    ctx.ui.notify("focus: knowledge entry deleted", "info");
  }
}

function activePath(ctx: CommandContext): FocusPath | null {
  return restoreFocusBinding(ctx.sessionManager.getBranch())?.binding.active ?? null;
}

function expected(container: { createdAt: string; revision: number }): { createdAt: string; revision: number } {
  return { createdAt: container.createdAt, revision: container.revision };
}

function updateFocusStatus(ctx: CommandContext, active: FocusPath | null, capabilities?: ReturnType<typeof activationCapabilities>): void {
  if (!active) {
    try { ctx.ui.setStatus("focus", undefined); } catch {}
    try { ctx.ui.setStatus("focus-capabilities", undefined); } catch {}
    try { ctx.ui.setTitle?.("pi"); } catch {}
    return;
  }
  try { ctx.ui.setStatus("focus", ctx.ui.theme.fg("accent", `focus:${active.focus.name}`)); } catch {}
  if (capabilities) {
    try { ctx.ui.setStatus("focus-capabilities", `focus: loadout_profile ${capabilities.loadoutProfile.status}; process ${capabilities.process.status}; subagent ${capabilities.subagent.status}`); } catch {}
  }
  try { ctx.ui.setTitle?.(`pi — ${active.focus.name}`); } catch {}
}

function handleStatus(ctx: CommandContext, active: FocusPath | null, capabilities?: ReturnType<typeof activationCapabilities>): void {
  if (!active) {
    ctx.ui.notify("focus: off", "info");
    return;
  }
  ctx.ui.notify(buildFocusContext(active, focusPaths(ctx.cwd, active), capabilities), "info");
}

function focusPaths(cwd: string, active: FocusPath): { focus: Record<string, string>; subfocus?: Record<string, string> } {
  const paths = (container: string) => ({ container, kb: join(container, "kb"), state: join(container, "state") });
  return {
    focus: paths(focusDirectory(cwd, active.focus.id)),
    ...(active.subfocus ? { subfocus: paths(subfocusDirectory(cwd, active.focus.id, active.subfocus.id)) } : {}),
  };
}

function sendFocusMessage(pi: ExtensionAPI, ctx: CommandContext, message: string): void {
  if (!pi.sendUserMessage) return;
  if (ctx.isIdle?.()) {
    pi.sendUserMessage(message);
  } else {
    pi.sendUserMessage(message, { deliverAs: "followUp" });
    ctx.ui.notify("focus: queued return-to-focus follow-up", "info");
  }
}

function focusHelp(): string {
  return [
    "focus context is injected automatically; loadout, monitor, script, and agent intents require explicit tool calls.",
    "focus KB and state paths are project-local.",
    "focus commands:",
    "  /focus            choose current, existing, or new focus",
    "  /focus <query>    choose a matching focus or create a new focus",
    "  /focus new        create and activate a new focus",
    "  /focus on         return the agent to captured last focus",
    "  /focus edit       edit active context or tool declarations",
    "  /focus delete     delete a focus after confirmation",
    "  /focus kb         manage active focus Markdown knowledge",
    "  /focus expand     append notes/refs/docs to active focus",
    "  /focus narrow     create an active subfocus",
    "  /focus use <id>   switch to an existing focus",
    "  /focus off        deactivate focus, keeping last focus",
    "  /focus status     show captured context and guard availability",
  ].join("\n");
}
