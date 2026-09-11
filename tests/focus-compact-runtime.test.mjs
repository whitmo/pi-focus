import assert from "node:assert/strict";
import test from "node:test";

import {
  BOUNDARY_CUSTOM_TYPE,
  DETAILS_KIND,
  MODEL_CUSTOM_TYPE,
  SCHEMA_VERSION,
  automaticThreshold,
  boundaryIsOnBranch,
  buildFocusSummaryPrompt,
  collectFileOperations,
  createBoundaryPayload,
  createCompactionDetails,
  createModelSetting,
  isFocusCompactionDetails,
  latestCompactionId,
  listFocusCompactionHistory,
  parseModelKey,
  restoreModelSetting,
  shouldAutoSchedule,
  summaryRequestFits,
} from "../extensions/focus-compact-runtime.mjs";

const capturedFocus = {
  entryId: "focus-binding-a",
  binding: {
    version: 1,
    agentSessionId: "session-a",
    marker: "captured-focus-only",
  },
};

function customEntry(id, customType, data) {
  return { id, type: "custom", customType, data };
}

function details(overrides = {}) {
  return createCompactionDetails({
    jobId: "job-a",
    sessionId: "session-a",
    sessionHeaderId: "header-a",
    boundaryId: "boundary-a",
    preBoundaryLeafId: "leaf-a",
    priorCompactionId: null,
    focusBinding: capturedFocus,
    trigger: "automatic",
    model: "openai:gpt-5.6-luna",
    startedAt: "2026-09-02T00:00:00.000Z",
    completedAt: "2026-09-02T00:00:01.000Z",
    tokensBefore: 96_000,
    readFiles: ["/read-only"],
    modifiedFiles: ["/modified"],
    ...overrides,
  });
}

test("exports stable tape and details contract identifiers", () => {
  assert.equal(BOUNDARY_CUSTOM_TYPE, "pi-focus.compaction-boundary");
  assert.equal(MODEL_CUSTOM_TYPE, "pi-focus.compaction-model");
  assert.equal(DETAILS_KIND, "pi-focus-background-compaction");
  assert.equal(SCHEMA_VERSION, 1);
});

test("schedules automatically at the bounded three-quarter context threshold", () => {
  assert.equal(automaticThreshold(200_000), 150_000);
  assert.equal(automaticThreshold(128_000), 96_000);
  assert.equal(automaticThreshold(1_000_000), 150_000);
  assert.equal(shouldAutoSchedule(96_000, 128_000), true);
  assert.equal(shouldAutoSchedule(95_999, 128_000), false);
  assert.equal(shouldAutoSchedule(null, 128_000), false);
  assert.equal(shouldAutoSchedule(100_000, 0), false);
});

test("parses exactly one non-empty provider/model separator", () => {
  assert.deepEqual(parseModelKey("openai:gpt-5.6-luna"), {
    provider: "openai",
    modelId: "gpt-5.6-luna",
  });
  for (const value of [null, "", "openai", ":gpt", "openai:", "openai:gpt:latest"]) {
    assert.equal(parseModelKey(value), null);
  }
});

test("creates frozen versioned model settings including the off state", () => {
  const selected = createModelSetting("openai:gpt-5.6-luna");
  const off = createModelSetting(null);

  assert.deepEqual(selected, { version: 1, modelKey: "openai:gpt-5.6-luna" });
  assert.deepEqual(off, { version: 1, modelKey: null });
  assert.equal(Object.isFrozen(selected), true);
  assert.throws(() => createModelSetting("openai:"), /invalid model/i);
});

test("restores the latest matching valid model setting and ignores unrelated entries", () => {
  const entries = [
    customEntry("model-old", MODEL_CUSTOM_TYPE, createModelSetting("openai:gpt-5.6-luna")),
    customEntry("model-latest", MODEL_CUSTOM_TYPE, createModelSetting(null)),
    customEntry("unrelated", "some.other.type", { nope: true }),
  ];

  assert.deepEqual(restoreModelSetting(entries), { modelKey: null, invalidLatest: false });
  assert.deepEqual(restoreModelSetting([]), { modelKey: null, invalidLatest: false });
});

test("fails model restoration closed when the latest matching entry is malformed", () => {
  const entries = [
    customEntry("model-valid", MODEL_CUSTOM_TYPE, createModelSetting("openai:gpt-5.6-luna")),
    customEntry("model-malformed", MODEL_CUSTOM_TYPE, { version: 2, modelKey: "openai:gpt-5.6-luna" }),
    customEntry("unrelated", "some.other.type", createModelSetting("other:model")),
  ];

  assert.deepEqual(restoreModelSetting(entries), { modelKey: null, invalidLatest: true });
});

test("creates a frozen boundary payload from required identity and captured focus", () => {
  const payload = createBoundaryPayload({
    jobId: "job-a",
    sessionId: "session-a",
    sessionHeaderId: "header-a",
    preBoundaryLeafId: null,
    priorCompactionId: null,
    focusBinding: capturedFocus,
    model: "openai:gpt-5.6-luna",
  });

  assert.deepEqual(payload, {
    version: 1,
    jobId: "job-a",
    sessionId: "session-a",
    sessionHeaderId: "header-a",
    preBoundaryLeafId: null,
    priorCompactionId: null,
    focusBindingEntryId: "focus-binding-a",
    focusBinding: capturedFocus.binding,
    model: "openai:gpt-5.6-luna",
  });
  assert.equal(Object.isFrozen(payload), true);

  const withoutFocus = createBoundaryPayload({
    jobId: "job-b",
    sessionId: "session-b",
    sessionHeaderId: "header-b",
    preBoundaryLeafId: "leaf-b",
    priorCompactionId: "compaction-a",
    focusBinding: null,
    model: "anthropic:claude-opus-4-6",
  });
  assert.equal(withoutFocus.focusBindingEntryId, null);
  assert.equal(withoutFocus.focusBinding, null);

  for (const field of ["jobId", "sessionId", "sessionHeaderId", "model"]) {
    const input = {
      jobId: "job-a",
      sessionId: "session-a",
      sessionHeaderId: "header-a",
      preBoundaryLeafId: null,
      priorCompactionId: null,
      focusBinding: null,
      model: "openai:gpt-5.6-luna",
    };
    delete input[field];
    assert.throws(() => createBoundaryPayload(input), /invalid boundary/i);
  }
});

test("finds compactions and boundaries only on the supplied active branch", () => {
  const entries = [
    { id: "compaction-a", type: "compaction", details: {} },
    customEntry("boundary-a", BOUNDARY_CUSTOM_TYPE, { version: 1 }),
    { id: "message-a", type: "message", boundaryId: "boundary-shadow" },
    { id: "compaction-b", type: "compaction", details: {} },
  ];

  assert.equal(latestCompactionId(entries), "compaction-b");
  assert.equal(latestCompactionId(entries.slice(0, 2)), "compaction-a");
  assert.equal(latestCompactionId([]), null);
  assert.equal(boundaryIsOnBranch(entries, "boundary-a"), true);
  assert.equal(boundaryIsOnBranch(entries, "boundary-shadow"), false);
  assert.equal(boundaryIsOnBranch(entries, null), false);
});

test("collects cumulative read-only and modified file operations", () => {
  const messages = [{
    role: "assistant",
    content: [
      { type: "toolCall", name: "read", arguments: { path: "/new-read" } },
      { type: "toolCall", name: "read", arguments: { file_path: "/later-edited" } },
      { type: "toolCall", name: "edit", arguments: { path: "/later-edited" } },
      { type: "toolCall", name: "write", arguments: { file_path: "/new-write" } },
      { type: "toolCall", name: "write", arguments: { path: "/inherited-read" } },
      { type: "toolCall", name: "bash", arguments: { path: "/ignored" } },
    ],
  }];
  const inherited = {
    readFiles: ["/inherited-read", "/old-read", "/old-read"],
    modifiedFiles: ["/old-modified", "/old-modified"],
  };

  assert.deepEqual(collectFileOperations(messages, inherited), {
    readFiles: ["/new-read", "/old-read"],
    modifiedFiles: ["/inherited-read", "/later-edited", "/new-write", "/old-modified"],
  });
});

test("builds a prompt from only the captured binding and serialized conversation", () => {
  const conversationText = "[User]: implement the captured focus\n[Assistant]: working";
  const currentFocus = {
    entryId: "focus-binding-current",
    binding: { marker: "live-focus-must-not-leak" },
  };
  const prompt = buildFocusSummaryPrompt({
    conversationText,
    focusBinding: capturedFocus,
    currentFocusBinding: currentFocus,
  });

  assert.match(prompt, /<captured-focus-binding-untrusted-json>/);
  assert.match(prompt, /<\/captured-focus-binding-untrusted-json>/);
  assert.ok(prompt.includes(JSON.stringify(capturedFocus)));
  assert.ok(prompt.includes(conversationText));
  assert.ok(prompt.includes("1. Preserve the captured focus identity, goals, constraints, decisions, unresolved work, and state-changing file/tool results precisely."));
  assert.ok(prompt.includes("2. Preserve related implementation context with provenance."));
  assert.ok(prompt.includes("3. Compress unrelated material to a short archive index."));
  assert.equal(prompt.includes(JSON.stringify(currentFocus)), false);
  assert.equal(prompt.includes("live-focus-must-not-leak"), false);
});

test("checks conservative prompt and output token fit", () => {
  assert.equal(summaryRequestFits("12345678", 12, 10), true);
  assert.equal(summaryRequestFits("12345678", 11, 10), false);
  assert.equal(summaryRequestFits("1", 11, 10), true);
  assert.equal(summaryRequestFits("prompt", 0, 10), false);
  assert.equal(summaryRequestFits("prompt", null, 10), false);
  assert.equal(summaryRequestFits("prompt", 100, 0), false);
});

test("creates the exact frozen compaction details payload", () => {
  const value = details();

  assert.deepEqual(value, {
    kind: "pi-focus-background-compaction",
    schemaVersion: 1,
    jobId: "job-a",
    sessionId: "session-a",
    sessionHeaderId: "header-a",
    boundaryId: "boundary-a",
    preBoundaryLeafId: "leaf-a",
    priorCompactionId: null,
    focusBindingEntryId: "focus-binding-a",
    focusBinding: capturedFocus.binding,
    trigger: "automatic",
    model: "openai:gpt-5.6-luna",
    startedAt: "2026-09-02T00:00:00.000Z",
    completedAt: "2026-09-02T00:00:01.000Z",
    tokensBefore: 96_000,
    readFiles: ["/read-only"],
    modifiedFiles: ["/modified"],
  });
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.readFiles), true);
  assert.equal(isFocusCompactionDetails(value), true);
  assert.equal(isFocusCompactionDetails({ ...value, schemaVersion: 2 }), false);
  assert.equal(isFocusCompactionDetails({ ...value, tokensBefore: -1 }), false);
});

test("lists only projected valid compaction details newest first", () => {
  const older = { ...details({ jobId: "job-old", completedAt: "2026-09-02T00:00:01.000Z" }), transcript: "secret transcript" };
  const newer = { ...details({ jobId: "job-new", completedAt: "2026-09-02T00:00:02.000Z" }), messages: ["secret message"] };
  const entries = [
    { id: "compaction-old", type: "compaction", summary: "secret summary", details: older },
    { id: "message", type: "message", details: newer },
    { id: "compaction-invalid", type: "compaction", details: { ...newer, kind: "other" } },
    { id: "compaction-new", type: "compaction", summary: "new secret summary", details: newer },
  ];

  const history = listFocusCompactionHistory(entries);

  assert.deepEqual(history.map((item) => item.jobId), ["job-new", "job-old"]);
  assert.equal("summary" in history[0], false);
  assert.equal("messages" in history[0], false);
  assert.equal("transcript" in history[1], false);
  assert.equal(Object.isFrozen(history), true);
  assert.equal(Object.isFrozen(history[0]), true);
});
