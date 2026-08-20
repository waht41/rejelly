import type { Message } from "@rejelly/core";
import type { PromptContext } from "@rejelly/core/policy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { NonUserMessageSource } from "../../shared/session/messageSource";
import type { SessionRecorder } from "../session/recorder/sessionRecorder";

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
});
