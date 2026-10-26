import {
  type AgentSnapshot,
  EVENTS,
  TRACE_EVENT_SCHEMA_VERSION,
  type TraceEvent,
} from "@rejelly/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTraceReplayModel,
  loadMockReplayFromTraceId,
  stripPromptJournal,
  traceEventsToMockInputs,
  traceEventsToReplaySteps,
} from "./mockFromTrace";

function baseTraceEvent(type: string, timestamp: number): TraceEvent {
  return {
    type,
    schemaVersion: TRACE_EVENT_SCHEMA_VERSION,
    timestamp,
    trace: { traceId: "trace_1", spanId: "span_1", parentSpanId: "" },
  } as TraceEvent;
}

function conversationStart(props: unknown, timestamp = 1): TraceEvent {
  return {
    ...baseTraceEvent(EVENTS.AGENT_START, timestamp),
    agentId: "evil_jelly_unified_agent",
    props,
    scopeLayers: [],
    resourceKeys: [],
    maxReborns: 1,
  };
}

function mockTraceFetch(props: unknown): void {
  const events: TraceEvent[] = [
    conversationStart(props),
    {
      ...baseTraceEvent(EVENTS.TURN_END, 2),
      step: 0,
      messages: [],
      messageCount: 0,
      resultType: "content",
      message: { role: "assistant", content: "hello back" },
      duration: 1,
      success: true,
    },
  ];
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(events)));
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
  afterEach(() => vi.restoreAllMocks());

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
            name: "list_directory",
            arguments: '{"dirPath": apps/devtool-ui/src/entities/trace/api}',
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
          name: "list_directory",
          arguments: '{"dirPath": apps/devtool-ui/src/entities/trace/api}',
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

  it("loads current message inputs when automatic input replay is enabled", async () => {
    mockTraceFetch({ message: { role: "user", content: "hello" } });

    const replay = await loadMockReplayFromTraceId("trace_1", true);

    expect(replay.inputs).toEqual(["hello"]);
    expect(replay.sequenceLength).toBe(1);
  });

  it("does not parse unsupported inputs during manual mock replay", async () => {
    mockTraceFetch({ userInput: "legacy input" });

    const replay = await loadMockReplayFromTraceId("trace_1", false);

    expect(replay.inputs).toEqual([]);
    expect(replay.sequenceLength).toBe(1);
  });

  it("reports unsupported inputs instead of falling back to manual input", async () => {
    mockTraceFetch({ userInput: "legacy input" });

    await expect(loadMockReplayFromTraceId("trace_1", true)).rejects.toThrow(
      "Unsupported mock input format",
    );
  });

  it("extracts current user messages in timestamp order and ignores other agents", () => {
    const events: TraceEvent[] = [
      conversationStart({ message: { role: "user", content: " second " } }, 3),
      {
        ...conversationStart({ message: { role: "user", content: "child only" } }, 2),
        agentId: "some_child_agent",
      },
      conversationStart({ message: { role: "user", content: " first " } }, 1),
    ];

    expect(traceEventsToMockInputs(events)).toEqual(["first", "second"]);
  });

  it("joins text content parts without adding separators", () => {
    const events = [
      conversationStart({
        message: {
          role: "user",
          content: [
            { type: "text", text: " hello" },
            { type: "text", text: " world " },
          ],
        },
      }),
    ];

    expect(traceEventsToMockInputs(events)).toEqual(["hello world"]);
  });

  it("preserves consecutive identical user messages", () => {
    const events = [
      conversationStart({ message: { role: "user", content: "again" } }, 1),
      conversationStart({ message: { role: "user", content: "again" } }, 2),
    ];

    expect(traceEventsToMockInputs(events)).toEqual(["again", "again"]);
  });

  it("returns no inputs for empty traces, empty messages, and compression operations", () => {
    expect(traceEventsToMockInputs([])).toEqual([]);
    expect(
      traceEventsToMockInputs([
        conversationStart({ message: { role: "user", content: " \n " } }),
        conversationStart({ message: { role: "user", content: [] } }),
        conversationStart({ operation: "compress", history: [] }),
      ]),
    ).toEqual([]);
  });

  it("does not recover inputs from the retired workspace agent", () => {
    const event = {
      ...conversationStart({ userInput: "legacy input" }),
      agentId: "evil_jelly_workspace_agent",
    };

    expect(traceEventsToMockInputs([event])).toEqual([]);
  });

  it.each(
    [
      undefined,
      null,
      [],
      {},
      { userInput: "legacy input" },
      { message: { role: "assistant", content: "not a user input" } },
      { message: { role: "user" } },
    ].map((props) => ({ props })),
  )("rejects unsupported conversation props: %j", ({ props }) => {
    expect(() => traceEventsToMockInputs([conversationStart(props)])).toThrow(
      "Unsupported mock input format",
    );
  });

  it.each(
    [
      null,
      42,
      [{ type: "text", text: 42 }],
      [null],
      [{ type: "image_url", image_url: { url: "attachment://sha256/image" } }],
      [
        { type: "text", text: "describe this" },
        { type: "image_url", image_url: { url: "attachment://sha256/image" } },
      ],
    ].map((content) => ({ content })),
  )("rejects unsupported content instead of silently losing input: %j", ({ content }) => {
    expect(() =>
      traceEventsToMockInputs([conversationStart({ message: { role: "user", content } })]),
    ).toThrow("Unsupported mock input format");
  });
});
