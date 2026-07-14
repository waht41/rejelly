/**
 * Mock Model Tests
 *
 * Tests for the MockModel testing utility
 */

import { describe, expect, it } from "vitest";
import { createMockModel } from "../mock-model";

describe("createMockModel", () => {
  it("creates a mock model instance", () => {
    const mock = createMockModel();

    expect(mock.adapter).toBeDefined();
    expect(mock.adapter.id).toBe("mock-model");
    expect(mock.calls).toBeDefined();
    expect(mock.when).toBeInstanceOf(Function);
  });
});

describe("when().thenReturn()", () => {
  it("returns object response", async () => {
    const mock = createMockModel();
    mock.when(() => true).thenReturn({ result: "ok" });

    const chunks: string[] = [];
    for await (const event of mock.adapter.stream([], {})) {
      if (event.type === "text") chunks.push(event.content);
    }

    expect(chunks.join("")).toBe('{"result":"ok"}');
  });

  it("returns string response", async () => {
    const mock = createMockModel();
    mock.when(() => true).thenReturn("plain text");

    const chunks: string[] = [];
    for await (const event of mock.adapter.stream([], {})) {
      if (event.type === "text") chunks.push(event.content);
    }

    expect(chunks.join("")).toBe("plain text");
  });
});

describe("when().thenStream()", () => {
  it("streams chunks", async () => {
    const mock = createMockModel();
    mock.when(() => true).thenStream(['{"a":', "1}"]);

    const chunks: string[] = [];
    for await (const event of mock.adapter.stream([], {})) {
      if (event.type === "text") chunks.push(event.content);
    }

    expect(chunks).toEqual(['{"a":', "1}"]);
  });

  it("streams multiple string chunks", async () => {
    const mock = createMockModel();
    mock.when(() => true).thenStream(["hello", " world"]);

    const chunks: string[] = [];
    for await (const event of mock.adapter.stream([], {})) {
      if (event.type === "text") chunks.push(event.content);
    }

    expect(chunks).toEqual(["hello", " world"]);
  });
});

describe("when().thenCallTools()", () => {
  it("returns tool call events", async () => {
    const mock = createMockModel();
    mock
      .when(() => true)
      .thenCallTools([{ id: "call_1", name: "search", arguments: { query: "test" } }]);

    const toolCalls: any[] = [];
    for await (const event of mock.adapter.stream([], {})) {
      if (event.type === "tool_call") toolCalls.push(event.toolCall);
    }

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("search");
    expect(toolCalls[0].arguments).toBe('{"query":"test"}');
  });

  it("forwards tool call extra metadata", async () => {
    const mock = createMockModel();
    mock
      .when(() => true)
      .thenCallTools([
        {
          id: "call_1",
          name: "search",
          arguments: { query: "test" },
          extra: { thoughtSignature: "sig_1" },
        },
      ]);

    const toolCalls: any[] = [];
    for await (const event of mock.adapter.stream([], {})) {
      if (event.type === "tool_call") toolCalls.push(event.toolCall);
    }

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].extra).toEqual({ thoughtSignature: "sig_1" });
  });

  it("returns multiple tool calls", async () => {
    const mock = createMockModel();
    mock
      .when(() => true)
      .thenCallTools([
        { id: "call_1", name: "tool_a", arguments: {} },
        { id: "call_2", name: "tool_b", arguments: {} },
      ]);

    const toolCalls: any[] = [];
    for await (const event of mock.adapter.stream([], {})) {
      if (event.type === "tool_call") toolCalls.push(event.toolCall);
    }

    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].name).toBe("tool_a");
    expect(toolCalls[1].name).toBe("tool_b");
  });
});

describe("when().thenThrow()", () => {
  it("throws specified error", async () => {
    const mock = createMockModel();
    mock.when(() => true).thenThrow(new Error("API Error"));

    await expect(async () => {
      for await (const _ of mock.adapter.stream([], {})) {
        // consume
      }
    }).rejects.toThrow("API Error");
  });
});

describe("withDelay()", () => {
  it("delays response", async () => {
    const mock = createMockModel();
    mock
      .when(() => true)
      .thenReturn({ ok: true })
      .withDelay(50);

    const start = Date.now();
    for await (const _ of mock.adapter.stream([], {})) {
      // consume
    }
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(50);
  });
});

describe("withUsage()", () => {
  it("includes usage event", async () => {
    const mock = createMockModel();
    mock
      .when(() => true)
      .thenReturn({ ok: true })
      .withUsage({ promptTokens: 100, completionTokens: 50 });

    let usage: any = null;
    for await (const event of mock.adapter.stream([], {})) {
      if (event.type === "usage") usage = event.usage;
    }

    expect(usage).toBeDefined();
    expect(usage.promptTokens).toBe(100);
    expect(usage.completionTokens).toBe(50);
    expect(usage.totalTokens).toBe(150);
  });
});

describe("withExtra()", () => {
  it("includes message-level extra event", async () => {
    const mock = createMockModel();
    mock
      .when(() => true)
      .thenReturn({ ok: true })
      .withExtra({ traceId: "t_1", safety: "low" });

    let extra: Record<string, unknown> | null = null;
    for await (const event of mock.adapter.stream([], {})) {
      if (event.type === "extra") extra = event.extra;
    }

    expect(extra).toEqual({ traceId: "t_1", safety: "low" });
  });
});

describe("sequence()", () => {
  it("supports sequence step tool_call and text", async () => {
    const mock = createMockModel();
    mock.sequence([
      {
        type: "tool_calls",
        calls: [{ id: "call_1", name: "search", arguments: { query: "test" } }],
      },
      { type: "text", content: "final answer" },
    ]);

    const firstEvents: string[] = [];
    for await (const event of mock.adapter.stream([], {})) {
      firstEvents.push(event.type);
    }

    const secondTexts: string[] = [];
    for await (const event of mock.adapter.stream([], {})) {
      if (event.type === "text") secondTexts.push(event.content);
    }

    expect(firstEvents).toContain("tool_call");
    expect(secondTexts.join("")).toBe("final answer");
  });

  it("supports sequence step extra metadata", async () => {
    const mock = createMockModel();
    mock.sequence([{ type: "text", content: "ok", extra: { traceId: "t_1" } }]);

    let extra: Record<string, unknown> | null = null;
    for await (const event of mock.adapter.stream([], {})) {
      if (event.type === "extra") extra = event.extra;
    }

    expect(extra).toEqual({ traceId: "t_1" });
  });

  it("supports sequence step error", async () => {
    const mock = createMockModel();
    mock.sequence([{ type: "error", error: new Error("timeout") }]);

    await expect(async () => {
      for await (const _ of mock.adapter.stream([], {})) {
        // consume
      }
    }).rejects.toThrow("timeout");
  });
});

describe("rule matching", () => {
  it("matches by input string", async () => {
    const mock = createMockModel();
    mock.when({ input: "hello" }).thenReturn({ greeting: "hi" });
    mock.setDefaultResponse({ greeting: "default" });

    const chunks: string[] = [];
    const messages = [{ role: "user" as const, content: "hello world" }];
    for await (const event of mock.adapter.stream(messages, {})) {
      if (event.type === "text") chunks.push(event.content);
    }

    expect(chunks.join("")).toBe('{"greeting":"hi"}');
  });

  it("matches by input regex", async () => {
    const mock = createMockModel();
    mock.when({ input: /search (.+)/ }).thenReturn({ action: "search" });
    mock.setDefaultResponse({ action: "default" });

    const chunks: string[] = [];
    const messages = [{ role: "user" as const, content: "search for AI" }];
    for await (const event of mock.adapter.stream(messages, {})) {
      if (event.type === "text") chunks.push(event.content);
    }

    expect(chunks.join("")).toBe('{"action":"search"}');
  });

  it("matches by function condition", async () => {
    const mock = createMockModel();
    mock.when((payload) => payload.messages.length > 1).thenReturn({ multi: true });
    mock.setDefaultResponse({ multi: false });

    const chunks: string[] = [];
    const messages = [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "user" },
    ];
    for await (const event of mock.adapter.stream(messages, {})) {
      if (event.type === "text") chunks.push(event.content);
    }

    expect(chunks.join("")).toBe('{"multi":true}');
  });

  it("uses first matching rule", async () => {
    const mock = createMockModel();
    mock.when(() => true).thenReturn({ first: true });
    mock.when(() => true).thenReturn({ second: true });

    const chunks: string[] = [];
    for await (const event of mock.adapter.stream([], {})) {
      if (event.type === "text") chunks.push(event.content);
    }

    expect(chunks.join("")).toBe('{"first":true}');
  });
});

describe("setDefaultResponse()", () => {
  it("uses default when no rule matches", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ fallback: true });

    const chunks: string[] = [];
    for await (const event of mock.adapter.stream([], {})) {
      if (event.type === "text") chunks.push(event.content);
    }

    expect(chunks.join("")).toBe('{"fallback":true}');
  });

  it("throws when no rule matches and no default", async () => {
    const mock = createMockModel();

    await expect(async () => {
      for await (const _ of mock.adapter.stream([], {})) {
        // consume
      }
    }).rejects.toThrow("No matching rule found");
  });
});

describe("calls API", () => {
  it("records all calls", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ ok: true });

    const messages1 = [{ role: "user" as const, content: "first" }];
    const messages2 = [{ role: "user" as const, content: "second" }];

    for await (const _ of mock.adapter.stream(messages1, {})) {
    }
    for await (const _ of mock.adapter.stream(messages2, {})) {
    }

    expect(mock.calls.count()).toBe(2);
    expect(mock.calls.all()).toHaveLength(2);
  });

  it("first() returns first call", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ ok: true });

    const messages = [{ role: "user" as const, content: "test" }];
    for await (const _ of mock.adapter.stream(messages, {})) {
    }

    const first = mock.calls.first();
    expect(first?.messages[0].content).toBe("test");
    expect(first?.index).toBe(0);
  });

  it("last() returns last call", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ ok: true });

    for await (const _ of mock.adapter.stream([{ role: "user" as const, content: "first" }], {})) {
    }
    for await (const _ of mock.adapter.stream([{ role: "user" as const, content: "second" }], {})) {
    }

    const last = mock.calls.last();
    expect(last?.messages[0].content).toBe("second");
    expect(last?.index).toBe(1);
  });

  it("clear() removes all records", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ ok: true });

    for await (const _ of mock.adapter.stream([], {})) {
    }
    for await (const _ of mock.adapter.stream([], {})) {
    }

    expect(mock.calls.count()).toBe(2);

    mock.calls.clear();

    expect(mock.calls.count()).toBe(0);
  });

  it("records schema", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ ok: true });

    const schema = { type: "object", properties: { name: { type: "string" } } };
    for await (const _ of mock.adapter.stream([], { schema })) {
    }

    expect(mock.calls.last()?.schema).toEqual(schema);
  });
});

describe("reset()", () => {
  it("clears rules, calls, and default", async () => {
    const mock = createMockModel();
    mock.when(() => true).thenReturn({ rule: true });
    mock.setDefaultResponse({ default: true });

    for await (const _ of mock.adapter.stream([], {})) {
    }

    mock.reset();

    expect(mock.calls.count()).toBe(0);

    await expect(async () => {
      for await (const _ of mock.adapter.stream([], {})) {
      }
    }).rejects.toThrow("No matching rule");
  });
});
