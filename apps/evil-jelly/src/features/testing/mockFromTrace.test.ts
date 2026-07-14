import { type AgentSnapshot, EVENTS, type TraceEvent } from "@rejelly/core";
import { describe, expect, it } from "vitest";
import {
  createTraceReplayModel,
  stripPromptJournal,
  traceEventsToMockInputs,
  traceEventsToReplaySteps,
} from "./mockFromTrace";

function baseTraceEvent(type: string, timestamp: number): TraceEvent {
  return {
    type,
    timestamp,
    trace: { traceId: "trace_1", spanId: "span_1", parentSpanId: "" },
  } as TraceEvent;
}

function emptyBudgetState(): AgentSnapshot["root"]["budgetState"] {
  const stats = {
    costs: {},
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    callCount: 0,
    items: [],
  };
  return { own: stats, aggregate: stats };
}

describe("mockFromTrace", () => {
  it("converts successful turn:end events including cache hits", () => {
    const events: TraceEvent[] = [
      {
        ...baseTraceEvent(EVENTS.TURN_END, 2),
        step: 1,
        messages: [],
        messageCount: 0,
        resultType: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", name: "read_file", arguments: '{"path":"a.ts"}' }],
        },
        duration: 10,
        success: true,
        cache: true,
      },
      {
        ...baseTraceEvent(EVENTS.TURN_END, 1),
        step: 0,
        messages: [],
        messageCount: 0,
        resultType: "content",
        message: { role: "assistant", content: "hello world" },
        duration: 24,
        success: true,
      },
    ];

    const steps = traceEventsToReplaySteps(events);

    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ type: "stream", chunks: ["hello world"] });
    expect(steps[1]).toMatchObject({
      type: "tool_calls",
      calls: [{ id: "call_1", name: "read_file", arguments: '{"path":"a.ts"}' }],
    });
  });

  it("replays raw tool call arguments without parsing them", async () => {
    const model = createTraceReplayModel([
      {
        type: "tool_calls",
        calls: [
          {
            id: "call_1",
            name: "ast_document_symbols",
            arguments: '{"filePath": apps/devtool-ui/src/entities/trace/api}',
          },
        ],
      },
    ]);

    const events = [];
    for await (const event of model.stream([])) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "tool_call",
        toolCall: {
          index: 0,
          id: "call_1",
          name: "ast_document_symbols",
          arguments: '{"filePath": apps/devtool-ui/src/entities/trace/api}',
        },
      },
      { type: "finish", finishReason: "tool_calls" },
    ]);
  });

  it("removes prompt journal recursively while retaining tool journal", () => {
    const snapshot: AgentSnapshot = {
      processId: "p_1",
      timestamp: 1,
      version: 1,
      provenance: { traceId: "trace_1" },
      root: {
        callId: "root",
        agentId: "root_agent",
        memory: {},
        journal: {
          prompt: { prompt_hash: { output: "old", contentHash: "prompt_hash" } },
          tool: { tool_hash: { output: "tool", contentHash: "tool_hash" } },
        },
        children: {
          child: {
            callId: "child",
            agentId: "child_agent",
            memory: {},
            journal: {
              prompt: { child_prompt: { output: "old", contentHash: "child_prompt" } },
              tool: { child_tool: { output: "tool", contentHash: "child_tool" } },
            },
            children: {},
            state: { status: "completed" },
            budgetState: emptyBudgetState(),
          },
        },
        state: { status: "completed" },
        budgetState: emptyBudgetState(),
      },
    };

    const stripped = stripPromptJournal(snapshot);

    expect(stripped.root.journal.prompt).toEqual({});
    expect(stripped.root.journal.tool.tool_hash?.output).toBe("tool");
    expect(stripped.root.children.child?.journal.prompt).toEqual({});
    expect(stripped.root.children.child?.journal.tool.child_tool?.output).toBe("tool");
    expect(snapshot.root.journal.prompt.prompt_hash).toBeDefined();
  });

  it("extracts queued user inputs from conversation agent starts", () => {
    const events: TraceEvent[] = [
      {
        ...baseTraceEvent(EVENTS.AGENT_START, 1),
        agentId: "evil_jelly_unified_agent",
        props: { userInput: " first " },
        scopeLayers: [],
        resourceKeys: [],
        maxReborns: 1,
      },
      {
        ...baseTraceEvent(EVENTS.AGENT_START, 2),
        agentId: "evil_jelly_unified_agent",
        props: { userInput: "first" },
        scopeLayers: [],
        resourceKeys: [],
        maxReborns: 1,
      },
      {
        ...baseTraceEvent(EVENTS.AGENT_START, 3),
        agentId: "some_child_agent",
        props: { userInput: "child only" },
        scopeLayers: [],
        resourceKeys: [],
        maxReborns: 1,
      },
      {
        ...baseTraceEvent(EVENTS.AGENT_START, 4),
        agentId: "evil_jelly_workspace_agent",
        props: { userInput: "second" },
        scopeLayers: [],
        resourceKeys: [],
        maxReborns: 1,
      },
    ];

    expect(traceEventsToMockInputs(events)).toEqual(["first", "second"]);
  });
});
