import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildStoredActiveContext, buildTranscript } from "./sessionHistoryProjection";
import { readSessionEvents } from "./sessionJsonlStore";
import { openSessionRecorder } from "./sessionRecorder";
import { prepareSessionReplay } from "./sessionReplay";

describe("sessionRecorder", () => {
  let tmpDir: string;
  let sessionsRoot: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "evil-session-recorder-"));
    sessionsRoot = path.join(tmpDir, "sessions");
    workspaceRoot = path.join(tmpDir, "workspace");
    await fs.mkdir(workspaceRoot);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const budget = {
    totalTokens: 30,
    promptTokens: 20,
    completionTokens: 10,
    cacheReadTokens: 5,
    callCount: 2,
    costs: { micro_usd: 4 },
    lastContextTokens: 12,
    lastCacheReadTokens: 3,
  };

  it("durably separates the full transcript from a compacted active checkpoint", async () => {
    const recorder = await openSessionRecorder({
      workspaceRoot,
      sessionId: "session-1",
      traceId: "trace-1",
      originator: "evil-jelly-cli",
      appVersion: "0.1.0",
      modelId: "test-model",
      provider: "test",
      cwd: workspaceRoot,
      sessionsRoot,
    });

    await recorder.recordMessage(
      "turn-1",
      { kind: "user_input", inputKind: "initial" },
      { role: "user", content: "inspect the store" },
    );
    await recorder.recordMessage(
      "turn-1",
      { kind: "model" },
      { role: "assistant", content: "old detailed response" },
    );
    await recorder.recordCompaction({
      trigger: "auto",
      activeTurnId: "turn-1",
      replacementHistory: [{ role: "user", content: "bounded checkpoint" }],
      beforeMessageCount: 2,
      beforeTokens: 100,
      afterTokens: 10,
      keptUserMessages: 1,
    });
    await recorder.recordMessage(
      "turn-1",
      { kind: "model" },
      { role: "assistant", content: "finished after compact" },
    );
    await recorder.completeTurn("turn-1", "completed", budget);
    await recorder.endSegment({ status: "completed", reason: "exit", budget });
    await recorder.close();

    const stored = await readSessionEvents(workspaceRoot, "session-1", { sessionsRoot });
    const replay = prepareSessionReplay(stored.events);

    expect(stored.events.map((event) => event.type)).toEqual([
      "run_segment_started",
      "message_recorded",
      "message_recorded",
      "context_compacted",
      "session_state",
      "message_recorded",
      "budget_updated",
      "turn_completed",
      "session_state",
      "run_segment_ended",
      "session_state",
    ]);
    expect(
      buildTranscript(replay).flatMap((item) =>
        item.type === "user" || item.type === "assistant" ? [item.content] : [],
      ),
    ).toEqual(["inspect the store", "old detailed response", "finished after compact"]);
    expect(buildStoredActiveContext(replay).map((message) => message.content)).toEqual([
      "bounded checkpoint",
      "finished after compact",
    ]);
    expect(stored.events.at(-1)).toMatchObject({
      type: "session_state",
      status: "idle",
      userTurns: 1,
      title: "inspect the store",
      traceIds: ["trace-1"],
      budget,
    });
  });

  it("opens a later trace as a resumed segment without rewriting the prior log", async () => {
    const first = await openSessionRecorder({
      workspaceRoot,
      sessionId: "session-2",
      traceId: "trace-1",
      originator: "evil-jelly-cli",
      appVersion: "0.1.0",
      modelId: "model-a",
      cwd: workspaceRoot,
      sessionsRoot,
    });
    await first.endSegment({ status: "completed", reason: "exit" });
    await first.close();

    const second = await openSessionRecorder({
      workspaceRoot,
      sessionId: "session-2",
      traceId: "trace-2",
      originator: "evil-jelly-cli",
      appVersion: "0.1.0",
      modelId: "model-b",
      cwd: workspaceRoot,
      sessionsRoot,
    });
    await second.endSegment({ status: "completed", reason: "exit" });
    await second.close();

    const stored = await readSessionEvents(workspaceRoot, "session-2", { sessionsRoot });
    expect(
      stored.events
        .filter((event) => event.type === "run_segment_started")
        .map((event) => ({ kind: event.kind, traceId: event.traceId, modelId: event.modelId })),
    ).toEqual([
      { kind: "created", traceId: "trace-1", modelId: "model-a" },
      { kind: "resumed", traceId: "trace-2", modelId: "model-b" },
    ]);
    expect(stored.events.at(-1)).toMatchObject({
      type: "session_state",
      traceIds: ["trace-1", "trace-2"],
    });
  });
});
