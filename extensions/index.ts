type ExtensionAPI = {
  on: (event: string, handler: (...args: any[]) => unknown) => void;
  registerCommand: (name: string, command: { description: string; handler: (args: string, ctx: CommandContext) => Promise<void> }) => void;
  sendUserMessage: (message: string, options?: { deliverAs: "followUp" }) => void;
};
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-ignore JS helper keeps the extension testable with plain node:test.
import {
  addFocusNote,
  createEmptyState,
  createFocus,
  createSubfocus,
  getActiveFocus,
  setActiveFocus,
  setFocusOff,
  findMatchingFoci,
  summarizeFocus,
} from "./focus-core.mjs";

type FocusState = {
  activeFocusId: string | null;
  lastFocusId: string | null;
  foci: Array<{ id: string; name: string; [key: string]: unknown }>;
  updatedAt: string | null;
};

type CommandContext = {
  cwd: string;
  hasUI: boolean;
  isIdle: () => boolean;
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

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_PARENT = join(HERE, "..", "skills");

export default function focusExtension(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    const state = loadState(ctx.cwd);
    updateFocusStatus(ctx as CommandContext, state);
  });

  pi.on("resources_discover", () => ({
    skillPaths: [SKILL_PARENT],
  }));

  pi.on("before_agent_start", (event, ctx) => {
    const state = loadState(ctx.cwd);
    const focus = getActiveFocus(state);
    if (!focus) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n## Current Focus\n\n${summarizeFocus(focus)}`,
    };
  });

  pi.registerCommand("focus", {
    description: "Set and steer the current work focus — use new | on | expand | narrow | off | status",
    handler: async (args: string, ctx: CommandContext) => {
      const [sub = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);

      if (!sub) {
        await handleChooser(ctx, pi);
      } else if (sub === "new") {
        await handleNew(ctx);
      } else if (sub === "on") {
        await handleOn(ctx, pi);
      } else if (sub === "expand") {
        await handleExpand(ctx);
      } else if (sub === "narrow") {
        await handleNarrow(ctx);
      } else if (sub === "off") {
        await handleOff(ctx);
      } else if (sub === "status") {
        await handleStatus(ctx);
      } else if (sub === "use") {
        await handleUse(ctx, rest.join(" "));
      } else if (sub === "help") {
        ctx.ui.notify(focusHelp(), "info");
      } else {
        await handleChooser(ctx, pi, [sub, ...rest].join(" "));
      }
    },
  });
}

async function handleChooser(ctx: CommandContext, pi: ExtensionAPI, query = ""): Promise<void> {
  const state = loadState(ctx.cwd);
  const matches = query ? findMatchingFoci(state.foci, query) : [];
  const options = query
    ? [
        ...matches.map((focus) => `${focus.id.toLowerCase() === query.toLowerCase() || focus.name.toLowerCase() === query.toLowerCase() ? "Use exact" : "Use related"} focus “${focus.name}” (${focus.id})`),
        `Create new focus “${query}”`,
      ]
    : [
        "View info on current focus",
        "Switch to a past/existing focus",
        "Create a new focus",
      ];
  const selected = await ctx.ui.select(query ? `Focus matches for “${query}”` : "Focus", options);
  if (!selected) return;

  if (!query) {
    if (selected === options[0]) return handleStatus(ctx);
    if (selected === options[1]) return handleSwitch(ctx, pi);
    return handleNew(ctx);
  }

  if (selected.startsWith("Create new focus")) {
    return handleNew(ctx, query);
  }
  const focus = matches[options.indexOf(selected)];
  if (focus) await activateFocus(ctx, pi, focus);
}

async function handleSwitch(ctx: CommandContext, pi: ExtensionAPI): Promise<void> {
  const state = loadState(ctx.cwd);
  const foci = [...state.foci.filter((focus) => focus.id !== state.activeFocusId), ...state.foci.filter((focus) => focus.id === state.activeFocusId)];
  if (!foci.length) {
    ctx.ui.notify("focus: no existing foci; run /focus new", "warning");
    return;
  }
  const options = foci.map((focus) => `${focus.name} (${focus.id})`);
  const selected = await ctx.ui.select("Switch focus", options);
  const focus = foci[options.indexOf(selected ?? "")];
  if (focus) await activateFocus(ctx, pi, focus);
}

async function handleNew(ctx: CommandContext, suppliedName?: string): Promise<void> {
  const name = suppliedName ?? await ctx.ui.input("Focus name", "e.g. Release planning");
  if (!name?.trim()) return;

  const goals = await ctx.ui.editor("Goals", "What are we trying to accomplish?");
  const scope = await ctx.ui.editor("Scope", "What is in bounds?");
  const constraints = await ctx.ui.editor("Constraints", "What must stay true?");
  const planningDocs = await ctx.ui.editor("Planning docs", "One path or URL per line");
  const refs = await ctx.ui.editor("Tickets, PRs, repos", "One reference per line");

  const state = createFocus(loadState(ctx.cwd), {
    name,
    goals,
    scope,
    constraints,
    planningDocs,
    refs,
  }) as FocusState;

  saveState(ctx.cwd, state);
  updateFocusStatus(ctx, state);
  ctx.ui.notify(`focus: active → ${getActiveFocus(state)?.name ?? name}`, "info");
}

async function handleOn(ctx: CommandContext, pi: ExtensionAPI): Promise<void> {
  let state = loadState(ctx.cwd);

  if (!state.activeFocusId && state.lastFocusId) {
    state = setActiveFocus(state, state.lastFocusId) as FocusState;
    saveState(ctx.cwd, state);
  }

  const focus = getActiveFocus(state);
  if (!focus) {
    ctx.ui.notify("focus: no active or previous focus; run /focus new", "warning");
    return;
  }

  updateFocusStatus(ctx, state);
  sendFocusMessage(pi, ctx, `Return to this focus and keep the next answer centered on it:\n\n${summarizeFocus(focus)}`);
}

async function handleExpand(ctx: CommandContext): Promise<void> {
  const note = await ctx.ui.editor("Add focus data", "Paste notes, docs, tickets, PRs, repos, or constraints");
  if (!note?.trim()) return;

  try {
    const state = addFocusNote(loadState(ctx.cwd), note) as FocusState;
    saveState(ctx.cwd, state);
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
    const state = createSubfocus(loadState(ctx.cwd), { name, goals, scope, constraints }) as FocusState;
    saveState(ctx.cwd, state);
    updateFocusStatus(ctx, state);
    ctx.ui.notify(`focus: narrowed → ${name.trim()}`, "info");
  } catch (error) {
    ctx.ui.notify(`focus: ${(error as Error).message}`, "warning");
  }
}

async function handleOff(ctx: CommandContext): Promise<void> {
  const state = setFocusOff(loadState(ctx.cwd)) as FocusState;
  saveState(ctx.cwd, state);
  updateFocusStatus(ctx, state);
  ctx.ui.notify("focus: off", "info");
}

async function handleStatus(ctx: CommandContext): Promise<void> {
  const state = loadState(ctx.cwd);
  const focus = getActiveFocus(state);
  ctx.ui.notify(focus ? summarizeFocus(focus) : "focus: off", "info");
}

async function activateFocus(ctx: CommandContext, pi: ExtensionAPI, focus: FocusState["foci"][number]): Promise<void> {
  const next = setActiveFocus(loadState(ctx.cwd), focus.id) as FocusState;
  saveState(ctx.cwd, next);
  updateFocusStatus(ctx, next);
  sendFocusMessage(pi, ctx, `Return to this focus and keep the next answer centered on it:\n\n${summarizeFocus(focus)}`);
}

async function handleUse(ctx: CommandContext, idOrName: string): Promise<void> {
  const state = loadState(ctx.cwd);
  const query = idOrName.trim().toLowerCase();
  const focus = state.foci.find((item) => item.id === query || item.name.toLowerCase() === query);
  if (!focus) {
    ctx.ui.notify(`focus: unknown focus ${idOrName || "(empty)"}`, "warning");
    return;
  }

  const next = setActiveFocus(state, focus.id) as FocusState;
  saveState(ctx.cwd, next);
  updateFocusStatus(ctx, next);
  ctx.ui.notify(`focus: active → ${focus.name}`, "info");
}

function loadState(cwd: string): FocusState {
  const path = statePath(cwd);
  if (!existsSync(path)) {
    return createEmptyState() as FocusState;
  }

  try {
    return JSON.parse(readFileSync(path, "utf8")) as FocusState;
  } catch {
    return createEmptyState() as FocusState;
  }
}

function saveState(cwd: string, state: FocusState): void {
  const path = statePath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function statePath(cwd: string): string {
  return join(findRepoRoot(cwd), ".agents", "focus", "state.json");
}

function findRepoRoot(start: string): string {
  let current = resolve(start || process.cwd());

  for (;;) {
    if (existsSync(join(current, ".agents"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return resolve(start || process.cwd());
    }
    current = parent;
  }
}

function updateFocusStatus(ctx: CommandContext, state: FocusState): void {
  const focus = getActiveFocus(state);
  if (!focus) {
    ctx.ui.setStatus("focus", undefined);
    ctx.ui.setTitle?.("pi");
    return;
  }

  ctx.ui.setStatus("focus", ctx.ui.theme.fg("accent", `focus:${focus.name}`));
  ctx.ui.setTitle?.(`pi — ${focus.name}`);
}

function sendFocusMessage(pi: ExtensionAPI, ctx: CommandContext, message: string): void {
  if (ctx.isIdle()) {
    pi.sendUserMessage(message);
  } else {
    pi.sendUserMessage(message, { deliverAs: "followUp" });
    ctx.ui.notify("focus: queued return-to-focus follow-up", "info");
  }
}

function focusHelp(): string {
  return [
    "focus commands:",
    "  /focus            choose current, existing, or new focus",
    "  /focus <query>    choose a matching focus or create a new one",
    "  /focus new        create and activate a new focus",
    "  /focus on         return the agent to current/last focus",
    "  /focus expand     append notes/refs/docs to active focus",
    "  /focus narrow     create an active subfocus",
    "  /focus use <id>   switch to an existing focus",
    "  /focus off        deactivate focus, keeping last focus",
    "  /focus status     show active focus",
  ].join("\n");
}
