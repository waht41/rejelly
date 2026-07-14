/**
 * Agent Core Tests
 *
 * Tests for createAgent and promptAgent functionality
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { createMockModel, schemas } from "../../testing/helpers";
import { AfterPromptAgentError, PromptAgentAlreadyCalledError } from "../domain/errors";
import { createAgent } from "../engine/agent";
import { reborn } from "../engine/flow/reborn";
import { equipInstruction, equipSystem } from "../facade/equip/equip";
import { promptAgent } from "../policy/prompt-schema";

describe("createAgent", () => {
  it("excludes reborn signals from the callable return type", async () => {
    let runCount = 0;
    const agent = createAgent({
      id: "agent_return_excludes_reborn",
      handler: async () => {
        runCount++;
        if (runCount === 1) return reborn();
        return "done" as const;
      },
    });

    const result = await agent();

    expectTypeOf(result).toEqualTypeOf<"done">();
    expect(result).toBe("done");
  });

  it("creates callable agent function", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent<{ input?: string }, { result: string }>({
      id: "test",
      model: mock.adapter,
      handler: async () => promptAgent(schemas.simple),
    });

    const result = await agent();
    expect(result.result).toBe("ok");
  });

  it("passes props to handler", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ echo: "hello" });

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async (props: { message: string }) => {
        equipInstruction(props.message);
        return promptAgent(z.object({ echo: z.string() }));
      },
    });

    await agent({ message: "hello" });

    const lastCall = mock.calls.last();
    expect(
      lastCall?.messages.some((m) => {
        if (!m.content) return false;
        if (typeof m.content === "string") {
          return m.content.includes("hello");
        }
        return m.content.some((part) => part.type === "text" && part.text.includes("hello"));
      }),
    ).toBe(true);
  });

  it("returns handler result", async () => {
    const agent = createAgent({
      id: "test",
      model: createMockModel().adapter,
      handler: async () => ({ custom: "value" }),
    });

    const result = await agent({});
    expect(result).toEqual({ custom: "value" });
  });
});

describe("promptAgent validation", () => {
  describe("schema validation", () => {
    it("validates basic types", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ name: "Alice", age: 25, active: true });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () =>
          promptAgent(
            z.object({
              name: z.string(),
              age: z.number(),
              active: z.boolean(),
            }),
          ),
      });

      const result = await agent({});
      expect(result).toEqual({ name: "Alice", age: 25, active: true });
    });

    it("validates enum values", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ status: "active" });

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () =>
          promptAgent(
            z.object({
              status: z.enum(["active", "inactive"]),
            }),
          ),
      });

      const result = await agent({});
      expect(result.status).toBe("active");
    });

    it("parses schema when mock returns prose prefix then fenced json", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse(
        "Now I have a complete understanding. Let me provide the structured analysis.\n\n" +
          "```json\n" +
          '{"name":"Alice","age":25}\n' +
          "```",
      );

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () =>
          promptAgent(
            z.object({
              name: z.string(),
              age: z.number(),
            }),
          ),
      });

      const result = await agent({});
      expect(result).toEqual({ name: "Alice", age: 25 });
    });

    it("parses schema when mock returns prose prefix then raw json", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse('Understood.\n\n{"name":"Bob","age":30}');

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () =>
          promptAgent(
            z.object({
              name: z.string(),
              age: z.number(),
            }),
          ),
      });

      const result = await agent({});
      expect(result).toEqual({ name: "Bob", age: 30 });
    });

    it("parses schema when prefixed fenced json is split across stream chunks", async () => {
      const mock = createMockModel();
      mock
        .when(() => true)
        .thenStream(["Here is the answer.\n\n```json\n", '{"name":"Carol","age":40}', "\n```"]);

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        handler: async () =>
          promptAgent(
            z.object({
              name: z.string(),
              age: z.number(),
            }),
          ),
      });

      const result = await agent({});
      expect(result).toEqual({ name: "Carol", age: 40 });
    });

    it("throws AttemptsExhaustedError on invalid data", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ name: 123 }); // wrong type

      const agent = createAgent({
        id: "test",
        model: mock.adapter,
        maxRetries: 0,
        handler: async () => promptAgent(z.object({ name: z.string() })),
      });

      const { AttemptsExhaustedError } = await import("../domain/errors");
      const err = await agent({}).catch((e) => e);
      expect(err).toBeInstanceOf(AttemptsExhaustedError);
      expect(err.message).toContain("All attempts exhausted");
    });
  });
});

describe("promptAgent call order", () => {
  it("throws PromptAgentAlreadyCalledError when promptAgent is called twice in the same run", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        await promptAgent(schemas.simple);
        await promptAgent(schemas.simple);
        return {};
      },
    });

    await expect(agent({})).rejects.toThrow(PromptAgentAlreadyCalledError);
  });

  it("throws AfterPromptAgentError when equip runs after promptAgent in the same run", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ result: "ok" });

    const agent = createAgent({
      id: "test",
      model: mock.adapter,
      handler: async () => {
        await promptAgent(schemas.simple);
        equipSystem("late");
        return {};
      },
    });

    await expect(agent({})).rejects.toThrow(AfterPromptAgentError);
  });
});
