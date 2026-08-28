import { fileURLToPath } from "node:url";

type ToolInfo = { name: string };

type ExtensionAPI = {
  on: (event: string, handler: (...args: any[]) => unknown) => void;
  registerCommand: (name: string, command: { description: string; handler: (args: string, ctx: CommandContext) => Promise<void> }) => void;
  sendUserMessage?: (message: string, options?: { deliverAs: "followUp" }) => void;
  getActiveTools?: () => string[];
  getAllTools?: () => ToolInfo[];
};

type FocusState = {
  activeFocusId: string | null;
  lastFocusId: string | null;
  foci: Array<{ id: string; name: string; activation?: { tools: string[] }; [key: string]: unknown }>;
  updatedAt: string | null;
};

type CommandContext = {
  cwd: string;
  hasUI: boolean;
  isIdle?: () => boolean;
  waitForIdle?: () => Promise<void>;
  ui: {
    input: (title: string, placeholder?: string) => Promise<string | undefined>;
    editor: (title: string, initial?: string) => Promise<string | undefined>;
    select: (title: string, options: string[]) => Promise<string | undefined>;
    notify: (message: string, level?: "info" | "warning" | "error" | string) => void;
    setStatus: (key: string, value: string | undefined) => void;
    setTitle?: (title: string) => void;
    theme: { fg: (color: string, text: string) => string };
  };
};

// @ts-ignore JS helpers keep the extension testable with plain node:test.
import {
  addFocusNote,
  createFocus,
  createSubfocus,
  deleteFocus,
  findMatchingFoci,
  getActiveFocus,
  setActiveFocus,
  setFocusOff,
  summarizeFocus,
  updateFocus,
} from "./focus-core.mjs";
// @ts-ignore JS helpers keep the extension testable with plain node:test.
import {
  deleteKnowledgeEntry,
  ensureFocusDirectories,
  focusDirectory,
  focusRoot,
  listKnowledgeEntries,
  loadFocusState,
  readKnowledgeEntry,
  removeFocusDirectory,
  updateFocusState,
  writeKnowledgeEntry,
} from "./focus-store.mjs";
// @ts-ignore JS helpers keep the extension testable with plain node:test.
import {
  activationCapabilities,
  buildFocusContext,
  resolveToolPolicy,
} from "./focus-runtime.mjs";

const SKILL_PARENT = fileURLToPath(new URL("../skills", import.meta.url));

export default function focusExtension(pi: ExtensionAPI) {
  const registeredTools = (): string[] => pi.getAllTools?.().map((tool) => tool.name) ?? [];
  const activeTools = (): string[] => pi.getActiveTools?.() ?? [];
  const capabilities = () => activationCapabilities(registeredTools(), activeTools());

  const activateFocus = async (ctx: CommandContext, transition: (state: FocusState) => FocusState, steer: boolean): Promise<void> => {
    await ctx.waitForIdle?.();
    const priorState = loadFocusState(ctx.cwd) as FocusState;
    let state: FocusState;
    let stateChanged = false;
    try {
      state = updateFocusState(ctx.cwd, (current: FocusState) => {
        const next = transition(current);
        const nextFocus = getActiveFocus(next);
        if (nextFocus) ensureFocusDirectories(ctx.cwd, nextFocus.id);
        return next;
      }) as FocusState;
      stateChanged = true;
      updateFocusStatus(ctx, state, capabilities());
    } catch (error) {
      if (stateChanged) updateFocusState(ctx.cwd, () => priorState);
      throw error;
    }
    const focus = getActiveFocus(state);
    if (!focus) return;
    if (steer) sendFocusMessage(pi, ctx, `Return to this focus and keep the next answer centered on it:\n\n${summarizeFocus(focus)}`);
  };

  pi.on("session_start", (_event, ctx) => {
    updateFocusStatus(ctx, loadFocusState(ctx.cwd) as FocusState, capabilities());
  });

  pi.on("resources_discover", () => ({ skillPaths: [SKILL_PARENT] }));

  pi.on("context", (event, ctx) => {
    const state = loadFocusState(ctx.cwd) as FocusState;
    const focus = getActiveFocus(state);
    if (!focus) return { messages: [...event.messages] };

    const paths = focusPaths(ctx.cwd, focus.id);
    const text = buildFocusContext(focus, paths, capabilities());
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

  pi.on("tool_call", (event, ctx) => {
    const focus = getActiveFocus(loadFocusState(ctx.cwd) as FocusState);
    const registered = registeredTools();
    const active = activeTools();
    const policy = resolveToolPolicy(focus?.activation?.tools, registered, active);
    if (!policy || policy.allowed.includes(event.toolName)) return;
    if (!policy.declared.includes(event.toolName)) {
      return { block: true, reason: `focus: ${event.toolName} is not declared by the active focus` };
    }
    if (!registered.includes(event.toolName)) {
      return { block: true, reason: `focus: ${event.toolName} is declared but not registered` };
    }
    return { block: true, reason: `focus: ${event.toolName} is declared but not active` };
  });

  pi.registerCommand("focus", {
    description: "Set and steer current work focus — use new | edit | delete | kb | on | expand | narrow | off | status",
    handler: async (args: string, ctx: CommandContext) => {
      if (ctx.hasUI === false) {
        ctx.ui.notify("focus: interactive focus management is unavailable in this host", "warning");
        return;
      }
      const [sub = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (!sub) {
        await handleChooser(ctx, activateFocus, "", capabilities());
      } else if (sub === "new") {
        await handleNew(ctx, activateFocus);
      } else if (sub === "on") {
        await handleOn(ctx, activateFocus);
      } else if (sub === "expand") {
        await handleExpand(ctx);
      } else if (sub === "narrow") {
        await handleNarrow(ctx);
      } else if (sub === "off") {
        const state = updateFocusState(ctx.cwd, (current: FocusState) => setFocusOff(current)) as FocusState;
        updateFocusStatus(ctx, state, capabilities());
        ctx.ui.notify("focus: off", "info");
      } else if (sub === "status") {
        handleStatus(ctx, capabilities());
      } else if (sub === "edit") {
        await handleEdit(ctx, capabilities());
      } else if (sub === "delete") {
        await handleDelete(ctx, capabilities());
      } else if (sub === "kb") {
        await handleKnowledgeBase(ctx);
      } else if (sub === "use") {
        await handleUse(ctx, rest.join(" "), activateFocus);
      } else if (sub === "help") {
        ctx.ui.notify(focusHelp(), "info");
      } else {
        await handleChooser(ctx, activateFocus, [sub, ...rest].join(" "), capabilities());
      }
    },
  });
}

type ActivateFocus = (ctx: CommandContext, transition: (state: FocusState) => FocusState, steer: boolean) => Promise<void>;

async function handleChooser(ctx: CommandContext, activateFocus: ActivateFocus, query = "", capabilities?: ReturnType<typeof activationCapabilities>): Promise<void> {
  const state = loadFocusState(ctx.cwd) as FocusState;
  const matches = query ? findMatchingFoci(state.foci, query) : [];
  const options = query
    ? [
        ...matches.map((focus) => `${focus.id.toLowerCase() === query.toLowerCase() || focus.name.toLowerCase() === query.toLowerCase() ? "Use exact" : "Use related"} focus “${focus.name}” (${focus.id})`),
        `Create new focus “${query}”`,
      ]
    : ["View info on current focus", "Switch to a past/existing focus", "Create a new focus"];
  const selected = await ctx.ui.select(query ? `Focus matches for “${query}”` : "Focus", options);
  if (!selected) return;
  if (!query) {
    if (selected === options[0]) return handleStatus(ctx, capabilities);
    if (selected === options[1]) return handleSwitch(ctx, activateFocus);
    return handleNew(ctx, activateFocus);
  }
  if (selected.startsWith("Create new focus")) return handleNew(ctx, activateFocus, query);
  const focus = matches[options.indexOf(selected)];
  if (focus) await activateFocus(ctx, (state) => setActiveFocus(state, focus.id), true);
}

async function handleSwitch(ctx: CommandContext, activateFocus: ActivateFocus): Promise<void> {
  const state = loadFocusState(ctx.cwd) as FocusState;
  const foci = [...state.foci.filter((focus) => focus.id !== state.activeFocusId), ...state.foci.filter((focus) => focus.id === state.activeFocusId)];
  if (!foci.length) {
    ctx.ui.notify("focus: no existing foci; run /focus new", "warning");
    return;
  }
  const options = foci.map((focus) => `${focus.name} (${focus.id})`);
  const selected = await ctx.ui.select("Switch focus", options);
  const focus = foci[options.indexOf(selected ?? "")];
  if (focus) await activateFocus(ctx, (state) => setActiveFocus(state, focus.id), true);
}

async function handleNew(ctx: CommandContext, activateFocus: ActivateFocus, suppliedName?: string): Promise<void> {
  const name = suppliedName ?? await ctx.ui.input("Focus name", "e.g. Release planning");
  if (!name?.trim()) return;
  const goals = await ctx.ui.editor("Goals", "What are we trying to accomplish?");
  const scope = await ctx.ui.editor("Scope", "What is in bounds?");
  const constraints = await ctx.ui.editor("Constraints", "What must stay true?");
  const planningDocs = await ctx.ui.editor("Planning docs", "One path or URL per line");
  const refs = await ctx.ui.editor("Tickets, PRs, repos", "One reference per line");
  await activateFocus(ctx, (state) => createFocus(state, { name, goals, scope, constraints, planningDocs, refs }), true);
}

async function handleOn(ctx: CommandContext, activateFocus: ActivateFocus): Promise<void> {
  const state = loadFocusState(ctx.cwd) as FocusState;
  const id = state.activeFocusId ?? state.lastFocusId;
  const focus = id ? state.foci.find((item) => item.id === id) : null;
  if (!focus) {
    ctx.ui.notify("focus: no active or previous focus; run /focus new", "warning");
    return;
  }
  await activateFocus(ctx, (current) => setActiveFocus(current, focus.id), true);
}

async function handleExpand(ctx: CommandContext): Promise<void> {
  const note = await ctx.ui.editor("Add focus data", "Paste notes, docs, tickets, PRs, repos, or constraints");
  if (!note?.trim()) return;
  try {
    const state = updateFocusState(ctx.cwd, (current: FocusState) => addFocusNote(current, note)) as FocusState;
    updateFocusStatus(ctx, state);
    ctx.ui.notify("focus: added note", "info");
  } catch (error) {
    ctx.ui.notify(`focus: ${(error as Error).message}`, "warning");
  }
}

async function handleNarrow(ctx: CommandContext): Promise<void> {
  const name = await ctx.ui.input("Subfocus name", "e.g. PR review");
  if (!name?.trim()) return;
  const goals = await ctx.ui.editor("Subfocus goals", "What is the narrower target?");
  const scope = await ctx.ui.editor("Subfocus scope", "What is in bounds for this slice?");
  const constraints = await ctx.ui.editor("Subfocus constraints", "What should not change?");
  try {
    const state = updateFocusState(ctx.cwd, (current: FocusState) => createSubfocus(current, { name, goals, scope, constraints })) as FocusState;
    updateFocusStatus(ctx, state);
    ctx.ui.notify(`focus: narrowed → ${name.trim()}`, "info");
  } catch (error) {
    ctx.ui.notify(`focus: ${(error as Error).message}`, "warning");
  }
}

async function handleUse(ctx: CommandContext, idOrName: string, activateFocus: ActivateFocus): Promise<void> {
  const state = loadFocusState(ctx.cwd) as FocusState;
  const query = idOrName.trim().toLowerCase();
  const focus = state.foci.find((item) => item.id === query || item.name.toLowerCase() === query);
  if (!focus) {
    ctx.ui.notify(`focus: unknown focus ${idOrName || "(empty)"}`, "warning");
    return;
  }
  await activateFocus(ctx, (current) => setActiveFocus(current, focus.id), true);
}

function updateFocusStatus(ctx: CommandContext, state: FocusState, capabilities?: ReturnType<typeof activationCapabilities>): void {
  const focus = getActiveFocus(state);
  if (!focus) {
    ctx.ui.setStatus("focus", undefined);
    ctx.ui.setStatus("focus-capabilities", undefined);
    ctx.ui.setTitle?.("pi");
    return;
  }
  ctx.ui.setStatus("focus", ctx.ui.theme.fg("accent", `focus:${focus.name}`));
  if (capabilities) {
    ctx.ui.setStatus("focus-capabilities", `focus: loadout_profile ${capabilities.loadoutProfile.status}; process ${capabilities.process.status}; subagent ${capabilities.subagent.status}`);
  }
  ctx.ui.setTitle?.(`pi — ${focus.name}`);
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

async function handleEdit(ctx: CommandContext, capabilities: ReturnType<typeof activationCapabilities>): Promise<void> {
  const focus = getActiveFocus(loadFocusState(ctx.cwd) as FocusState);
  if (!focus) {
    ctx.ui.notify("focus: no active focus to edit", "warning");
    return;
  }
  const field = await ctx.ui.select("Edit focus", ["Goals", "Scope", "Constraints", "Planning docs", "Refs", "Tool declarations"]);
  if (!field) return;
  const key = field === "Planning docs" ? "planningDocs" : field === "Tool declarations" ? "activation" : field.toLowerCase();
  const initial = key === "activation" ? (focus.activation?.tools ?? []).join("\n") : String(focus[key] ?? "");
  const value = await ctx.ui.editor(field, initial);
  if (value === undefined) return;
  const state = updateFocusState(ctx.cwd, (current: FocusState) => updateFocus(current, focus.id, key === "activation" ? { activation: { tools: value.split(/[\n,]/) } } : { [key]: value })) as FocusState;
  updateFocusStatus(ctx, state, capabilities);
  ctx.ui.notify(`focus: updated ${field.toLowerCase()}`, "info");
}

async function handleDelete(ctx: CommandContext, capabilities: ReturnType<typeof activationCapabilities>): Promise<void> {
  const state = loadFocusState(ctx.cwd) as FocusState;
  if (!state.foci.length) {
    ctx.ui.notify("focus: no foci to delete", "warning");
    return;
  }
  const options = state.foci.map((focus) => `${focus.name} (${focus.id})`);
  const selected = await ctx.ui.select("Delete focus", options);
  const focus = state.foci[options.indexOf(selected ?? "")];
  if (!focus) return;
  const confirmed = await ctx.ui.select(`Delete “${focus.name}”?`, ["Cancel", `Delete “${focus.name}”`]);
  if (confirmed !== `Delete “${focus.name}”`) return;
  const next = updateFocusState(ctx.cwd, (current: FocusState) => deleteFocus(current, focus.id)) as FocusState;
  removeFocusDirectory(ctx.cwd, focus.id);
  updateFocusStatus(ctx, next, capabilities);
  ctx.ui.notify(`focus: deleted ${focus.name}`, "info");
}

async function handleKnowledgeBase(ctx: CommandContext): Promise<void> {
  const focus = getActiveFocus(loadFocusState(ctx.cwd) as FocusState);
  if (!focus) {
    ctx.ui.notify("focus: no active focus knowledge base", "warning");
    return;
  }
  const entries = listKnowledgeEntries(ctx.cwd, focus.id);
  const selected = await ctx.ui.select("Focus knowledge base", [...entries, "Create new entry"]);
  if (!selected) return;
  if (selected === "Create new entry") {
    const name = await ctx.ui.input("Knowledge entry name", "e.g. plan");
    if (!name?.trim()) return;
    const content = await ctx.ui.editor("Knowledge entry", "");
    if (content === undefined) return;
    writeKnowledgeEntry(ctx.cwd, focus.id, name, content);
    ctx.ui.notify("focus: knowledge entry saved", "info");
    return;
  }
  const action = await ctx.ui.select(`Knowledge: ${selected}`, ["Edit entry", "Delete entry"]);
  if (action === "Edit entry") {
    const content = await ctx.ui.editor(`Knowledge: ${selected}`, readKnowledgeEntry(ctx.cwd, focus.id, selected));
    if (content === undefined) return;
    writeKnowledgeEntry(ctx.cwd, focus.id, selected, content);
    ctx.ui.notify("focus: knowledge entry saved", "info");
    return;
  }
  if (action === "Delete entry") {
    const confirmed = await ctx.ui.select(`Delete “${selected}”?`, ["Cancel", `Delete “${selected}”`]);
    if (confirmed !== `Delete “${selected}”`) return;
    deleteKnowledgeEntry(ctx.cwd, focus.id, selected);
    ctx.ui.notify("focus: knowledge entry deleted", "info");
  }
}

function handleStatus(ctx: CommandContext, capabilities?: ReturnType<typeof activationCapabilities>): void {
  const focus = getActiveFocus(loadFocusState(ctx.cwd) as FocusState);
  if (!focus) {
    ctx.ui.notify("focus: off", "info");
    return;
  }
  ctx.ui.notify(buildFocusContext(focus, focusPaths(ctx.cwd, focus.id), capabilities), "info");
}

function focusPaths(cwd: string, focusId: string): { focus: string; kb: string; stateIndex: string; focusState: string } {
  const focus = focusDirectory(cwd, focusId);
  return {
    focus,
    kb: `${focus}/kb`,
    stateIndex: `${focusRoot(cwd)}/state.json`,
    focusState: `${focus}/state`,
  };
}

function focusHelp(): string {
  return [
    "focus context is injected automatically; loadout, monitor, script, and agent intents require explicit tool calls.",
    "focus KB and state paths are project-local.",
    "focus commands:",
    "  /focus            choose current, existing, or new focus",
    "  /focus <query>    choose a matching focus or create a new focus",
    "  /focus new        create and activate a new focus",
    "  /focus on         return the agent to current/last focus",
    "  /focus edit       edit active context or tool declarations",
    "  /focus delete     delete a focus after confirmation",
    "  /focus kb         manage active focus Markdown knowledge",
    "  /focus expand     append notes/refs/docs to active focus",
    "  /focus narrow     create an active subfocus",
    "  /focus use <id>   switch to an existing focus",
    "  /focus off        deactivate focus, keeping last focus",
    "  /focus status     show paths, restrictions, and capability availability",
  ].join("\n");
}
