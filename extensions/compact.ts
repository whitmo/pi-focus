import { randomUUID } from "node:crypto";

import {
  buildSessionContext,
  convertToLlm,
  serializeConversation,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// @ts-ignore JavaScript runtime contracts are covered by focused node:test suites.
import {
  BOUNDARY_CUSTOM_TYPE,
  buildFocusSummaryPrompt,
  collectFileOperations,
  createBoundaryPayload,
  latestCompactionId,
  parseModelKey,
  restoreModelSetting,
  shouldAutoSchedule,
  summaryRequestFits,
} from "./focus-compact-runtime.mjs";
// @ts-ignore JavaScript runtime contracts are covered by focused node:test suites.
import { restoreFocusBinding } from "./focus-session.mjs";

type Trigger = "automatic" | "command" | "tool";
type PendingRequest = { trigger: Trigger } | null;
type JobPhase = "running" | "ready" | "committing";
type Model = NonNullable<ExtensionContext["model"]>;
type Completion = Awaited<ReturnType<ExtensionContext["modelRegistry"]["complete"]>>;

type CompactionJob = {
  id: string;
  generation: number;
  context: ExtensionContext;
  phase: JobPhase;
  controller: AbortController;
  model: Model;
  modelName: string;
  sessionId: string;
  sessionHeaderId: string;
  boundaryId: string;
  preBoundaryLeafId: string | null;
  priorCompactionId: string | null;
  focusBinding: unknown;
  trigger: Trigger;
  tokensBefore: number;
  firstKeptEntryId: string;
  readFiles: string[];
  modifiedFiles: string[];
  startedAt: string;
  summary?: string;
  usage?: Completion["usage"];
};

type RequestResult = "scheduled" | "coalesced";

export default function compactExtension(pi: ExtensionAPI): void {
  let generation = 0;
  let activeContext: ExtensionContext | null = null;
  let pending: PendingRequest = null;
  let captureRequested: PendingRequest = null;
  let job: CompactionJob | null = null;
  let modelKey: string | null = null;

  const probe = (
    requested: Exclude<PendingRequest, null>,
    ctx: ExtensionContext,
  ): void => {
    ctx.compact({
      onError: () => {
        if (captureRequested !== requested) return;
        captureRequested = null;
        notify(ctx, "focus compact: not enough history", "warning");
      },
    });
  };

  const request = (trigger: Trigger, ctx: ExtensionContext): RequestResult => {
    if (pending !== null || captureRequested !== null || job !== null) {
      return "coalesced";
    }
    const requested = { trigger };
    if (!ctx.isIdle()) {
      pending = requested;
      return "scheduled";
    }
    captureRequested = requested;
    probe(requested, ctx);
    return "scheduled";
  };

  const resolveModel = (ctx: ExtensionContext): Model | undefined => {
    if (modelKey === null) return ctx.model;
    const parsed = parseModelKey(modelKey);
    return parsed === null
      ? undefined
      : ctx.modelRegistry.find(parsed.provider, parsed.modelId);
  };

  const isCurrent = (target: CompactionJob): boolean => (
    generation === target.generation
    && activeContext === target.context
    && job === target
    && !target.controller.signal.aborted
  );

  const fail = (target: CompactionJob, error: unknown): void => {
    if (!isCurrent(target)) return;
    job = null;
    const message = error instanceof Error ? error.message : String(error);
    notify(target.context, `focus compact: ${message}`, "warning");
  };

  const runSummary = async (
    target: CompactionJob,
    conversationText: string,
  ): Promise<void> => {
    const prompt = buildFocusSummaryPrompt({
      conversationText,
      focusBinding: target.focusBinding,
    });
    const configuredMax = target.model.maxTokens;
    const maxTokens = typeof configuredMax === "number" && configuredMax > 0
      ? Math.min(8192, configuredMax)
      : 8192;
    if (!summaryRequestFits(prompt, target.model.contextWindow, maxTokens)) {
      throw new Error("summary request exceeds model context");
    }

    const auth = await target.context.modelRegistry.getApiKeyAndHeaders(target.model);
    if (!isCurrent(target)) return;
    if (!auth.ok) throw new Error(auth.error);

    const response = await target.context.modelRegistry.complete(
      target.model,
      {
        messages: [{
          role: "user",
          content: [{ type: "text", text: prompt }],
          timestamp: Date.now(),
        }],
      },
      {
        maxTokens,
        signal: target.controller.signal,
        cacheRetention: "none",
        sessionId: randomUUID(),
      },
    );
    if (!isCurrent(target)) return;
    if (["error", "length", "aborted"].includes(response.stopReason)) {
      throw new Error(`summary stopped: ${response.stopReason}`);
    }

    const summary = response.content
      .flatMap((part) => part.type === "text" ? [part.text] : [])
      .join("\n")
      .trim();
    if (summary.length === 0) throw new Error("summary was empty");
    if (!isCurrent(target)) return;

    target.summary = summary;
    target.usage = response.usage;
    target.phase = "ready";
  };

  const capture = (
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ): { cancel: true } => {
    const requested = captureRequested;
    if (requested === null) return { cancel: true };

    const branchEntries = [...event.branchEntries];
    const activeBranch = [...ctx.sessionManager.getBranch()];
    const preBoundaryLeafId = ctx.sessionManager.getLeafId();
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionHeaderId = ctx.sessionManager.getHeader()?.id ?? sessionId;
    const priorCompactionId = latestCompactionId(activeBranch);
    const selectedModel = resolveModel(ctx);
    captureRequested = null;

    if (selectedModel === undefined) {
      notify(ctx, "focus compact: no model available", "warning");
      return { cancel: true };
    }

    const id = randomUUID();
    const focusBinding = restoreFocusBinding(activeBranch);
    const modelName = `${selectedModel.provider}:${selectedModel.id}`;
    pi.appendEntry(BOUNDARY_CUSTOM_TYPE, createBoundaryPayload({
      jobId: id,
      sessionId,
      sessionHeaderId,
      preBoundaryLeafId,
      priorCompactionId,
      focusBinding,
      model: modelName,
    }));
    const boundaryId = ctx.sessionManager.getLeafId();
    if (boundaryId === null || boundaryId === preBoundaryLeafId) {
      notify(ctx, "focus compact: boundary capture failed", "warning");
      return { cancel: true };
    }

    const messages = buildSessionContext(branchEntries).messages;
    const files = collectFileOperations(messages, event.preparation.fileOps);
    const controller = new AbortController();
    const capturedJob: CompactionJob = {
      id,
      generation,
      context: ctx,
      phase: "running",
      controller,
      model: selectedModel,
      modelName,
      sessionId,
      sessionHeaderId,
      boundaryId,
      preBoundaryLeafId,
      priorCompactionId,
      focusBinding,
      trigger: requested.trigger,
      tokensBefore: event.preparation.tokensBefore,
      firstKeptEntryId: boundaryId,
      readFiles: [...files.readFiles],
      modifiedFiles: [...files.modifiedFiles],
      startedAt: new Date().toISOString(),
    };
    job = capturedJob;

    const conversationText = serializeConversation(convertToLlm(messages));
    void runSummary(capturedJob, conversationText).catch((error: unknown) => {
      fail(capturedJob, error);
    });
    return { cancel: true };
  };

  pi.on("session_start", (_event, ctx) => {
    generation += 1;
    job?.controller.abort();
    activeContext = ctx;
    pending = null;
    captureRequested = null;
    job = null;
    modelKey = restoreModelSetting(ctx.sessionManager.getBranch()).modelKey;
  });

  pi.on("session_before_compact", (event, ctx) => {
    if (captureRequested === null) return;
    return capture(event, ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (job?.phase === "ready") return;
    if (pending !== null) {
      const requested = pending;
      pending = null;
      captureRequested = requested;
      probe(requested, ctx);
      return;
    }
    const usage = ctx.getContextUsage();
    if (shouldAutoSchedule(usage?.tokens, ctx.model?.contextWindow)) {
      request("automatic", ctx);
    }
  });

  pi.registerCommand("focus-compact", {
    description: "Schedule focus-weighted background compaction",
    handler: async (_args, ctx) => {
      const result = request("command", ctx);
      notify(ctx, `focus compact: ${result}`, "info");
    },
  });

  pi.registerTool({
    name: "focus_compact",
    label: "Focus Compact",
    description: "Schedule focus-weighted background compaction without blocking",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const status = request("tool", ctx);
      return {
        content: [{ type: "text", text: `focus compact: ${status}` }],
        details: { status },
      };
    },
  });
}

function notify(
  ctx: ExtensionContext,
  message: string,
  level: "info" | "warning",
): void {
  if (ctx.hasUI) ctx.ui.notify(message.slice(0, 180), level);
}
