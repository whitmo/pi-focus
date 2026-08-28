import { fileURLToPath } from "node:url";

type ToolInfo = { name: string };

type ExtensionAPI = {
  on: (event: string, handler: (...args: any[]) => unknown) => void;
  registerCommand: (name: string, command: { description: string; handler: (args: string, ctx: CommandContext) => Promise<void> }) => void;
  sendUserMessage?: (message: string, options?: { deliverAs: "followUp" }) => void;
  getActiveTools?: () => string[];
  getAllTools?: () => ToolInfo[];
  setActiveTools?: (tools: string[]) => void;
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
  findMatchingFoci,
  getActiveFocus,
  setActiveFocus,
  setFocusOff,
  summarizeFocus,
} from "./focus-core.mjs";
// @ts-ignore JS helpers keep the extension testable with plain node:test.
import {
  ensureFocusDirectories,
  focusDirectory,
  loadFocusState,
  updateFocusState,
} from "./focus-store.mjs";
// @ts-ignore JS helpers keep the extension testable with plain node:test.
import {
  activationCapabilities,
  buildFocusContext,
  restrictTools,
} from "./focus-runtime.mjs";

const SKILL_PARENT = fileURLToPath(new URL("../skills", import.meta.url));

export default function focusExtension(pi: ExtensionAPI) {
  let baselineTools: string[] | undefined;
  let restrictedTools: string[] | undefined;
  let ownsRestriction = false;

  const registeredTools = (): string[] => pi.getAllTools?.().map((tool) => tool.name) ?? [];
  const capabilities = () => activationCapabilities(registeredTools());

  const restoreTools = (): void => {
    if (!ownsRestriction || baselineTools === undefined || !pi.setActiveTools) return;
    pi.setActiveTools(baselineTools);
    baselineTools = undefined;
    restrictedTools = undefined;
    ownsRestriction = false;
  };

  const reapplyTools = (ctx: { cwd: string; ui?: CommandContext["ui"] }): FocusState => {
    const state = loadFocusState(ctx.cwd) as FocusState;
    const focus = getActiveFocus(state);
    if (!focus || !pi.getActiveTools || !pi.setActiveTools) {
      if (!focus) restoreTools();
      updateFocusStatus(ctx as CommandContext, state, capabilities());
      return state;
    }

    baselineTools ??= pi.getActiveTools();
    restrictedTools = restrictTools(baselineTools, focus.activation?.tools, registeredTools());
    ownsRestriction = true;
    pi.setActiveTools(restrictedTools);
    updateFocusStatus(ctx as CommandContext, state, capabilities());
    return state;
  };

  const activateFocus = async (ctx: CommandContext, transition: (state: FocusState) => FocusState, steer: boolean): Promise<void> => {
    await ctx.waitForIdle?.();
    const state = updateFocusState(ctx.cwd, transition) as FocusState;
    const focus = getActiveFocus(state);
    if (!focus) return;

    ensureFocusDirectories(ctx.cwd, focus.id);
    reapplyTools(ctx);
    if (steer) sendFocusMessage(pi, ctx, `Return to this focus and keep the next answer centered on it:\n\n${summarizeFocus(focus)}`);
  };

  pi.on("session_start", (_event, ctx) => {
    reapplyTools(ctx);
  });

  pi.on("resources_discover", () => ({ skillPaths: [SKILL_PARENT] }));

  pi.on("context", (event, ctx) => {
    const state = loadFocusState(ctx.cwd) as FocusState;
    const focus = getActiveFocus(state);
    if (!focus) return { messages: [...event.messages] };

    const paths = {
      focus: focusDirectory(ctx.cwd, focus.id),
      kb: `${focusDirectory(ctx.cwd, focus.id)}/kb`,
      state: `${focusDirectory(ctx.cwd, focus.id)}/state`,
    };
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

  pi.on("before_agent_start", (_event, ctx) => {
    reapplyTools(ctx);
  });

  pi.on("tool_call", (event) => {
    if (ownsRestriction && restrictedTools && !restrictedTools.includes(event.toolName)) {
      return { block: true, reason: `focus: ${event.toolName} is outside the active focus tool restriction` };
    }
  });

  pi.on("tool_result", (event, ctx) => {
    if (event.toolName === "loadout_profile") reapplyTools(ctx);
  });

  pi.on("session_before_tree", () => {
    restoreTools();
  });
  pi.on("session_tree", (_event, ctx) => {
    reapplyTools(ctx);
  });
  pi.on("session_shutdown", () => {
    restoreTools();
  });

  pi.registerCommand("focus", {
    description: "Set and steer the current work focus — use new | on | expand | narrow | off | status",
    handler: async (args: string, ctx: CommandContext) => {
      const [sub = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (!sub) {
        await handleChooser(ctx, activateFocus);
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
        restoreTools();
        updateFocusStatus(ctx, state, capabilities());
        ctx.ui.notify("focus: off", "info");
      } else if (sub === "status") {
        handleStatus(ctx);
      } else if (sub === "use") {
        await handleUse(ctx, rest.join(" "), activateFocus);
      } else if (sub === "help") {
        ctx.ui.notify(focusHelp(), "info");
      } else {
        await handleChooser(ctx, activateFocus, [sub, ...rest].join(" "));
      }
    },
  });
}

type ActivateFocus = (ctx: CommandContext, transition: (state: FocusState) => FocusState, steer: boolean) => Promise<void>;

async function handleChooser(ctx: CommandContext, activateFocus: ActivateFocus, query = ""): Promise<void> {
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
    if (selected === options[0]) return handleStatus(ctx);
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
  await activateFocus(ctx, (state) => createFocus(state, { name, goals, scope, constraints, planningDocs, refs }), false);
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
  await activateFocus(ctx, (current) => setActiveFocus(current, focus.id), false);
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
    const unavailable = [
      capabilities.loadoutProfile.available ? null : "loadout_profile",
      capabilities.process.available ? null : "process",
      capabilities.subagent.available ? null : "subagent",
    ].filter(Boolean);
    ctx.ui.setStatus("focus-capabilities", unavailable.length ? `focus: ${unavailable.join(", ")} unavailable; requires explicit invocation` : "focus: declared capabilities require explicit invocation");
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

function handleStatus(ctx: CommandContext): void {
  const focus = getActiveFocus(loadFocusState(ctx.cwd) as FocusState);
  ctx.ui.notify(focus ? summarizeFocus(focus) : "focus: off", "info");
}

function focusHelp(): string {
  return [
    "focus commands:",
    "  /focus            choose current, existing, or new focus",
    "  /focus <query>    choose a matching focus or create a new focus",
    "  /focus new        create and activate a new focus",
    "  /focus on         return the agent to current/last focus",
    "  /focus expand     append notes/refs/docs to active focus",
    "  /focus narrow     create an active subfocus",
    "  /focus use <id>   switch to an existing focus",
    "  /focus off        deactivate focus, keeping last focus",
    "  /focus status     show active focus",
  ].join("\n");
}
