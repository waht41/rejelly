import { AbortError, type Message, ModelCallError } from "@rejelly/core";
import type { PromptContext } from "@rejelly/core/policy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SessionRecorder } from "../../../domains/session/recorder/sessionRecorder";
import { recordModelFailureProgress } from "../../../shared/model/modelFailureProgress";
import type { NonUserMessageSource } from "../../../shared/session/messageSource";

const policyMocks = vi.hoisted(() => ({
  executeValidatedLoopTurn: vi.fn(),
  executeTools: vi.fn(),
}));

vi.mock("@rejelly/core/policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rejelly/core/policy")>()),
  executeValidatedLoopTurn: policyMocks.executeValidatedLoopTurn,
  executeTools: policyMocks.executeTools,
}));

import { runResilientToolCallLoopPolicy } from "./resilientToolLoop";

describe("runResilientToolCallLoopPolicy session recorder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("awaits steer, model-round, and tool-result batches in completion order", async () => {
    const modelCall: Message = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call-1", name: "read_file", arguments: "{}" }],
    };
    const toolResult: Message = {
      role: "tool",
      tool_call_id: "call-1",
      content: "file body",
    };
    const final: Message = { role: "assistant", content: "done" };
    policyMocks.executeValidatedLoopTurn
      .mockResolvedValueOnce({
        kind: "tool_calls",
        calls: modelCall.tool_calls,
        deltaMessages: [modelCall],
      })
      .mockResolvedValueOnce({
        kind: "content",
        data: "done",
        deltaMessages: [final],
      });
    policyMocks.executeTools.mockResolvedValueOnce([toolResult]);

    const recorded: string[] = [];
    const recordMessage = vi.fn(async (_turnId, source, message) => {
      recorded.push(`${source.kind}:${message.role}`);
    });
    const recorder = {
      recordMessage,
      recordMessages: vi.fn(
        async (_turnId, entries: readonly { source: NonUserMessageSource; message: Message }[]) => {
          recorded.push(
            entries.map((entry) => `${entry.source.kind}:${entry.message.role}`).join(","),
          );
        },
      ),
    } as unknown as SessionRecorder;
    const ctx = {
      maxTurnSteps: 3,
      maxRetries: 0,
      messages: [],
      tools: [],
      fork: vi.fn(function (this: PromptContext, overrides) {
        return { ...this, ...overrides };
      }),
      span: { setAttribute: vi.fn() },
    } as unknown as PromptContext;
    let pendingRound = 0;
    let dispatchRound = 0;
    const toolsForDispatch = vi.fn(async () => [
      {
        name: `dispatch_${++dispatchRound}`,
        description: "dispatch-scoped tool",
        parameters: z.object({}),
        handler: async () => "ok",
      },
    ]);
    const pendingUserMessage: Message = {
      role: "user",
      content: "prepared: also inspect tests",
    };

    const result = await runResilientToolCallLoopPolicy(ctx, {
      turnId: "turn-1",
      sessionRecorder: recorder,
      pendingUserMessages: async () => (pendingRound++ === 0 ? [pendingUserMessage] : []),
      toolsForDispatch,
    });

    expect(result).toMatchObject({ aborted: false, data: "done" });
    expect(recordMessage).not.toHaveBeenCalled();
    expect(policyMocks.executeValidatedLoopTurn.mock.calls[0]?.[0].runtime.messages[0]).toBe(
      pendingUserMessage,
    );
    expect(recorded).toEqual(["model:assistant", "tool:tool", "model:assistant"]);
    expect(policyMocks.executeValidatedLoopTurn.mock.calls[0]?.[0].runtime.tools[0]?.name).toBe(
      "dispatch_1",
    );
    expect(policyMocks.executeTools.mock.calls[0]?.[1].runtime.tools[0]?.name).toBe("dispatch_1");
    expect(policyMocks.executeValidatedLoopTurn.mock.calls[1]?.[0].runtime.tools[0]?.name).toBe(
      "dispatch_2",
    );
    expect(toolsForDispatch).toHaveBeenCalledTimes(2);
  });

  it.each([
    false,
    true,
    undefined,
  ])("only checkpoints a model dispatch with confirmed pre-output failure (yielded=%s)", async (yielded) => {
    const user: Message = { role: "user", content: "inspect" };
    const steer: Message = { role: "user", content: "also inspect tests" };
    const modelCall: Message = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "checkpoint-tool", name: "read_file", arguments: "{}" }],
    };
    const toolResult: Message = {
      role: "tool",
      tool_call_id: "checkpoint-tool",
      content: "file body",
    };
    const error = new ModelCallError("connection failed", {
      modelId: "checkpoint-model",
      code: "connection_error",
    });
    if (yielded !== undefined) recordModelFailureProgress(error, yielded);
    policyMocks.executeValidatedLoopTurn
      .mockResolvedValueOnce({
        kind: "tool_calls",
        calls: modelCall.tool_calls,
        deltaMessages: [modelCall],
      })
      .mockRejectedValueOnce(error);
    policyMocks.executeTools.mockResolvedValueOnce([toolResult]);
    const ctx = {
      maxTurnSteps: 3,
      maxRetries: 0,
      messages: [{ role: "system", content: "equipped rules" }, user],
      tools: [],
      fork: vi.fn(function (this: PromptContext, overrides) {
        return { ...this, ...overrides };
      }),
      span: { setAttribute: vi.fn() },
    } as unknown as PromptContext;
    let round = 0;
    const checkpoint = vi.fn();

    await expect(
      runResilientToolCallLoopPolicy(ctx, {
        pendingUserMessages: () => (round++ === 1 ? [steer] : []),
        onModelRetryCheckpoint: checkpoint,
      }),
    ).rejects.toBe(error);
    if (yielded === false) {
      expect(checkpoint).toHaveBeenCalledExactlyOnceWith([user, modelCall, toolResult, steer]);
    } else {
      expect(checkpoint).not.toHaveBeenCalled();
    }
    expect(policyMocks.executeTools).toHaveBeenCalledTimes(1);
  });

  it("does not checkpoint a tool failure even if it carries pre-output model progress", async () => {
    const modelCall: Message = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "failed-tool", name: "read_file", arguments: "{}" }],
    };
    const error = new ModelCallError("tool's model failed", {
      modelId: "tool-model",
      code: "server_error",
    });
    recordModelFailureProgress(error, false);
    policyMocks.executeValidatedLoopTurn.mockResolvedValueOnce({
      kind: "tool_calls",
      calls: modelCall.tool_calls,
      deltaMessages: [modelCall],
    });
    policyMocks.executeTools.mockRejectedValueOnce(error);
    const ctx = {
      maxTurnSteps: 3,
      maxRetries: 0,
      messages: [],
      tools: [],
      fork: vi.fn(function (this: PromptContext, overrides) {
        return { ...this, ...overrides };
      }),
      span: { setAttribute: vi.fn() },
    } as unknown as PromptContext;
    const checkpoint = vi.fn();
    await expect(
      runResilientToolCallLoopPolicy(ctx, { onModelRetryCheckpoint: checkpoint }),
    ).rejects.toBe(error);
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it("reports a requested tool before local execution starts", async () => {
    const modelCall: Message = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call-requested", name: "read_file", arguments: "{}" }],
    };
    policyMocks.executeValidatedLoopTurn.mockResolvedValueOnce({
      kind: "tool_calls",
      calls: modelCall.tool_calls,
      deltaMessages: [modelCall],
    });
    const recorder = {
      recordMessages: vi.fn(async () => {
        throw new AbortError("interrupted before tool execution");
      }),
    } as unknown as SessionRecorder;
    const ctx = {
      maxTurnSteps: 3,
      maxRetries: 0,
      messages: [],
      tools: [],
      fork: vi.fn(function (this: PromptContext, overrides) {
        return { ...this, ...overrides };
      }),
      span: { setAttribute: vi.fn() },
    } as unknown as PromptContext;
    const progress: string[] = [];

    await expect(
      runResilientToolCallLoopPolicy(ctx, {
        turnId: "turn-requested",
        sessionRecorder: recorder,
        onTurnProgress: (event) => progress.push(event),
      }),
    ).resolves.toMatchObject({ aborted: true });
    expect(progress).toEqual(["model_output", "tool_requested"]);
    expect(policyMocks.executeTools).not.toHaveBeenCalled();
  });

  it("reports a running tool when local execution is interrupted", async () => {
    const modelCall: Message = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call-running", name: "read_file", arguments: "{}" }],
    };
    policyMocks.executeValidatedLoopTurn.mockResolvedValueOnce({
      kind: "tool_calls",
      calls: modelCall.tool_calls,
      deltaMessages: [modelCall],
    });
    policyMocks.executeTools.mockRejectedValueOnce(new AbortError("interrupted during tool"));
    const ctx = {
      maxTurnSteps: 3,
      maxRetries: 0,
      messages: [],
      tools: [],
      fork: vi.fn(function (this: PromptContext, overrides) {
        return { ...this, ...overrides };
      }),
      span: { setAttribute: vi.fn() },
    } as unknown as PromptContext;
    const progress: string[] = [];

    await expect(
      runResilientToolCallLoopPolicy(ctx, {
        onTurnProgress: (event) => progress.push(event),
      }),
    ).resolves.toMatchObject({ aborted: true });
    expect(progress).toEqual(["model_output", "tool_requested", "tool_execution_started"]);
  });

  it("uses a resumed provider anchor instead of re-estimating the whole context", async () => {
    const hugeHistory: Message[] = [{ role: "user", content: "x".repeat(4000) }];
    const final: Message = { role: "assistant", content: "done" };
    policyMocks.executeValidatedLoopTurn.mockResolvedValueOnce({
      kind: "content",
      data: "done",
      deltaMessages: [final],
    });
    const ctx = {
      maxTurnSteps: 3,
      maxRetries: 0,
      messages: hugeHistory,
      tools: [],
      fork: vi.fn(function (this: PromptContext, overrides) {
        return { ...this, ...overrides };
      }),
      span: { setAttribute: vi.fn() },
    } as unknown as PromptContext;

    await expect(
      runResilientToolCallLoopPolicy(ctx, {
        pendingUserMessages: () => [
          { role: "user", content: "one" },
          { role: "user", content: "two" },
          { role: "user", content: "three" },
        ],
        compaction: { thresholdTokens: 100, summaryInstruction: "summarize" },
        initialTokenAnchor: { promptTokens: 10, messages: hugeHistory },
      }),
    ).resolves.toMatchObject({ aborted: false, data: "done" });
    expect(policyMocks.executeValidatedLoopTurn).toHaveBeenCalledTimes(1);
  });

  it("re-anchors later rounds from the Evil-owned provider usage reader", async () => {
    const hugeHistory: Message[] = [{ role: "user", content: "x".repeat(4000) }];
    const modelCall: Message = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call-1", name: "read_file", arguments: "{}" }],
    };
    const final: Message = { role: "assistant", content: "done" };
    let usage = { revision: 0, promptTokens: 0 };
    policyMocks.executeValidatedLoopTurn
      .mockImplementationOnce(async () => {
        usage = { revision: 1, promptTokens: 10 };
        return {
          kind: "tool_calls",
          calls: modelCall.tool_calls,
          deltaMessages: [modelCall],
        };
      })
      .mockResolvedValueOnce({ kind: "content", data: "done", deltaMessages: [final] });
    policyMocks.executeTools.mockResolvedValueOnce([
      { role: "tool", tool_call_id: "call-1", content: "small" },
    ]);
    let pendingRound = 0;
    const ctx = {
      maxTurnSteps: 3,
      maxRetries: 0,
      messages: hugeHistory,
      tools: [],
      fork: vi.fn(function (this: PromptContext, overrides) {
        return { ...this, ...overrides };
      }),
      span: { setAttribute: vi.fn() },
    } as unknown as PromptContext;

    await expect(
      runResilientToolCallLoopPolicy(ctx, {
        pendingUserMessages: () =>
          pendingRound++ === 1 ? [{ role: "user", content: "also inspect tests" }] : [],
        compaction: { thresholdTokens: 100, summaryInstruction: "summarize" },
        promptTokenUsage: { read: () => usage },
      }),
    ).resolves.toMatchObject({ aborted: false, data: "done" });
    expect(policyMocks.executeValidatedLoopTurn).toHaveBeenCalledTimes(2);
  });
});
