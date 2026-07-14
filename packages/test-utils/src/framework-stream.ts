/**
 * Framework stream tests: basic stream, equipTool, custom policy stream options
 *
 * Shared real E2E tests. Each adapter package runs this suite with a real adapter
 * when API key is set; skip when not.
 *
 * @example
 * // In adapter package stream.test.ts
 * const runE2E = process.env.GEMINI_API_KEY ? describe : describe.skip
 * runE2E('...', () => {
 *   if (!process.env.GEMINI_API_KEY) return
 *   runFrameworkStreamTests(() => createGeminiAdapter({ apiKey: process.env.GEMINI_API_KEY! }))
 * })
 */
/// <reference types="vitest/globals" />

import type { Message, ModelAdapter, ToolChoice } from "@rejelly/core";
import { createAgent, equipInstruction, equipTool, promptAgent } from "@rejelly/core";
import { createAgentPolicy, executeTools, executeTurn } from "@rejelly/core/policy";
import { z } from "zod";
import type { TestCapabilities } from "./capabilities";
import { runScenarioSuite, type TestScenario } from "./run-suite";

/** Boolean result schema to reduce flakiness (assert bool instead of string). */
const resultSchema = z.object({ ok: z.boolean() });

const forceToolChat = createAgentPolicy({
  policyId: "test-force-tool-chat",
  handler: async (ctx, toolChoice: ToolChoice): Promise<{ data: string; delta: Message[] }> => {
    const firstTurn = await executeTurn(ctx.messages, {
      runtime: ctx,
      toolChoice,
    });
    const toolCalls = firstTurn.message.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      return {
        data: typeof firstTurn.message.content === "string" ? firstTurn.message.content : "",
        delta: [firstTurn.message],
      };
    }

    const toolOutputs = await executeTools(toolCalls, {
      runtime: ctx.fork({ messages: [...ctx.messages, firstTurn.message] }),
    });
    const messages = [...ctx.messages, firstTurn.message, ...toolOutputs];
    const finalTurn = await executeTurn(messages, {
      runtime: ctx.fork({ messages }),
    });

    return {
      data: typeof finalTurn.message.content === "string" ? finalTurn.message.content : "",
      delta: [firstTurn.message, ...toolOutputs, finalTurn.message],
    };
  },
});

export const frameworkStream: TestScenario[] = [
  {
    name: "basic stream: createAgent + promptAgent returns parsed result",
    capabilitiesRequired: ["basicStream"],
    handler: async (adapter: ModelAdapter) => {
      const agent = createAgent({
        id: "test",
        model: adapter,
        handler: async () => {
          equipInstruction('return {"ok":true}');
          return promptAgent(resultSchema);
        },
      });

      const result = await agent({});
      expect(result.ok).toBe(true);
    },
  },
  {
    name: "equipTool: tools are passed to adapter and agent completes",
    capabilitiesRequired: ["toolCall"],
    handler: async (adapter: ModelAdapter) => {
      const agent = createAgent({
        id: "test",
        model: adapter,
        handler: async () => {
          equipTool({
            name: "get_weather",
            description: "Get weather",
            parameters: z.object({ city: z.string() }),
            handler: async () => ({ data: "done" }),
          });
          equipInstruction("this is test, just return true");
          return promptAgent(resultSchema);
        },
      });

      const result = await agent({});
      expect(result.ok).toBe(true);
    },
  },
  {
    name: "tool call loop: model returns exactly the random char from tool",
    capabilitiesRequired: ["toolCall", "toolChoice"],
    handler: async (adapter: ModelAdapter) => {
      let toolCalled = false;
      let randomChar = "";
      const agent = createAgent({
        id: "test",
        model: adapter,
        handler: async () => {
          equipTool({
            name: "random_char",
            description: "Generate a random lowercase English string and return it in field char.",
            parameters: z.object({}),
            handler: async () => {
              toolCalled = true;
              randomChar = "xczsafxvg";
              return { char: randomChar };
            },
          });
          const toolChoice: ToolChoice = {
            type: "function",
            function: { name: "random_char" },
          };
          equipInstruction(
            "Call tool random_char once, then return only the tool result field char as plain text. No JSON, no quotes, no markdown, no extra words.",
          );
          return forceToolChat(toolChoice);
        },
      });

      const result = await agent({});
      expect(toolCalled).toBe(true);
      expect(result.data.trim()).toBe(randomChar);
    },
  },
  {
    name: "tool loop: registered tool output is available to final response",
    capabilitiesRequired: ["toolCall"],
    handler: async (adapter: ModelAdapter) => {
      let dummyToolCalled = false;
      const agent = createAgent({
        id: "test",
        model: adapter,
        handler: async () => {
          equipTool({
            name: "dummy",
            description: "Dummy",
            parameters: z.object({}),
            handler: async () => {
              dummyToolCalled = true;
              return {};
            },
          });
          equipInstruction('Call dummy once, then return {"ok":true}');
          return promptAgent(resultSchema);
        },
      });

      const result = await agent({});
      expect(dummyToolCalled).toBe(true);
      expect(result.ok).toBe(true);
    },
  },
];

/**
 * Runs framework stream tests: basic stream, equipTool, custom policy stream options.
 * Uses Vitest describe/it/expect (globals). The adapter package must mock the SDK.
 * Real adapter must return JSON `{"ok":true}` for the given instructions.
 */
export function runFrameworkStreamTests(
  getAdapter: () => ModelAdapter,
  capabilities: TestCapabilities,
): void {
  runScenarioSuite("Complex Scenarios Integration", frameworkStream, getAdapter, capabilities);
}
