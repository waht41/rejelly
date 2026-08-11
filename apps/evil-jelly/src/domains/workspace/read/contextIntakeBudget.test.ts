import type { Message, ToolCall, ToolCallLoopContext, ToolOutput } from "@rejelly/core";
import { describe, expect, it } from "vitest";
import { createContextIntakeBudgetMiddleware } from "./contextIntakeBudget";

function call(id: string, name: string): ToolCall {
  return { id, name, arguments: {} } as unknown as ToolCall;
}

/** ~4 chars/token, so `chars` characters of ASCII content ≈ chars/4 tokens. */
function body(chars: number): string {
  return "a".repeat(chars);
}

/** A loop context whose live conversation is ~`approxTokens` tokens (a single message). */
function ctxWithOccupancy(approxTokens: number): ToolCallLoopContext {
  const messages: Message[] = [
    { role: "tool", tool_call_id: "seed", content: body(approxTokens * 4) },
  ];
  return { messages } as unknown as ToolCallLoopContext;
}

/** Fake executor: returns the predefined content for whichever calls it is handed. */
function makeNext(contentByCallId: Record<string, string | null>) {
  return async (calls: ToolCall[]): Promise<ToolOutput[]> =>
    calls.map((c) => ({
      callId: c.id,
      content: c.id in contentByCallId ? contentByCallId[c.id] : "",
    }));
}

describe("createContextIntakeBudgetMiddleware (stateless)", () => {
  it("passes budgeted output through untouched below the warn band", async () => {
    const mw = createContextIntakeBudgetMiddleware({
      name: "intake",
      maxTokens: 100,
      warnRatio: 0.8,
      budgetedTools: ["read_file"],
    });
    const outputs = await mw.handler(
      ctxWithOccupancy(50), // below warn (80)
      [call("a", "read_file")],
      makeNext({ a: body(200) }),
    );
    expect(outputs[0].content).toBe(body(200));
  });

  it("nudges the last budgeted output when occupancy is in the warn band", async () => {
    const mw = createContextIntakeBudgetMiddleware({
      name: "intake",
      maxTokens: 100,
      warnRatio: 0.8,
      budgetedTools: ["read_file"],
    });
    const outputs = await mw.handler(
      ctxWithOccupancy(85), // in [80, 100)
      [call("a", "read_file")],
      makeNext({ a: body(40) }),
    );
    expect(outputs[0].content).toContain("context budget warning");
  });

  it("refuses budgeted calls without executing once occupancy reaches the cap", async () => {
    const mw = createContextIntakeBudgetMiddleware({
      name: "intake",
      maxTokens: 100,
      budgetedTools: ["read_file"],
    });
    const next = makeNext({ b: "SHOULD_NOT_RUN", c: "real-list-output" });
    const outputs = await mw.handler(
      ctxWithOccupancy(120), // over the cap
      [call("b", "read_file"), call("c", "list_directory")],
      next,
    );

    const refused = outputs.find((o) => o.callId === "b");
    const passed = outputs.find((o) => o.callId === "c");
    expect(refused?.content).toContain("context budget reached");
    expect(refused?.content).not.toContain("SHOULD_NOT_RUN");
    expect(passed?.content).toBe("real-list-output");
  });

  it("never refuses or annotates non-budgeted tools, even over the cap", async () => {
    const mw = createContextIntakeBudgetMiddleware({
      name: "intake",
      maxTokens: 10,
      budgetedTools: ["read_file"],
    });
    const outputs = await mw.handler(
      ctxWithOccupancy(500), // far over the cap
      [call("a", "other_tool")],
      makeNext({ a: body(4000) }),
    );
    expect(outputs[0].content).toBe(body(4000));
  });

  it("stateless: occupancy is read fresh each batch, so a shrunken context re-opens reads", async () => {
    const mw = createContextIntakeBudgetMiddleware({
      name: "intake",
      maxTokens: 100,
      budgetedTools: ["read_file"],
    });
    // Over the cap → refused.
    const refused = await mw.handler(
      ctxWithOccupancy(150),
      [call("a", "read_file")],
      makeNext({ a: "real" }),
    );
    expect(refused[0].content).toContain("context budget reached");

    // Context later shrinks (e.g. after a reborn/trim) → the same middleware allows reads again,
    // with no reset call, because it holds no accumulated state.
    const allowed = await mw.handler(
      ctxWithOccupancy(20),
      [call("b", "read_file")],
      makeNext({ b: "real" }),
    );
    expect(allowed[0].content).toBe("real");
  });
});
