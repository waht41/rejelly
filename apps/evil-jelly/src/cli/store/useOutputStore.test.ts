import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isRuntimeActive,
  resetOutputSession,
  TOOL_FULL_CAP,
  type ToolBlock,
  useOutputStore,
} from "./useOutputStore";

beforeEach(() => {
  resetOutputSession();
});

afterEach(() => {
  resetOutputSession();
  vi.useRealTimers();
});

describe("isRuntimeActive", () => {
  it("does not treat input waits as active runtime work", () => {
    expect(isRuntimeActive("Ready", "")).toBe(false);
    expect(isRuntimeActive("Waiting for input", "")).toBe(false);
    expect(isRuntimeActive("Waiting for user choice…", "")).toBe(false);
  });

  it("treats running statuses and stream output as active runtime work", () => {
    expect(isRuntimeActive("Running…", "")).toBe(true);
    expect(isRuntimeActive("shell → .", "")).toBe(true);
    expect(isRuntimeActive("Ready", "partial output")).toBe(true);
  });
});

describe("logTool", () => {
  it("adds a tool turn to history with summary as content", () => {
    useOutputStore.setState({ history: [], toolProgress: [] });
    const block: ToolBlock = {
      toolName: "grep",
      summary: '[Tools] grep "needle"',
      preview: "src/a.ts:1:needle",
      fullResult: "src/a.ts:1:needle\nsrc/b.ts:2:needle",
      ok: true,
    };
    const store = useOutputStore.getState();
    store.logTool(block);

    const history = useOutputStore.getState().history;
    expect(history).toHaveLength(1);
    const turn = history[0]!;
    expect(turn.type).toBe("tool");
    if (turn.type === "tool") {
      expect(turn.content).toBe('[Tools] grep "needle"');
      expect(turn.tool.toolName).toBe("grep");
      expect(turn.tool.fullResult).toBe("src/a.ts:1:needle\nsrc/b.ts:2:needle");
      expect(turn.tool.ok).toBe(true);
      expect(turn.tool.ordinal).toBe(1);
    }
  });

  it("numbers tool turns by tool-call order", () => {
    const store = useOutputStore.getState();
    store.logTool({
      toolName: "read_file",
      summary: "[Tools] read_file -> a",
      preview: "a",
      fullResult: "a",
      ok: true,
    });
    store.logAssistant("between");
    store.logTool({
      toolName: "grep",
      summary: "[Tools] grep -> b",
      preview: "b",
      fullResult: "b",
      ok: true,
    });

    const tools = useOutputStore
      .getState()
      .history.filter(
        (turn): turn is Extract<typeof turn, { type: "tool" }> => turn.type === "tool",
      );
    expect(tools.map((turn) => turn.tool.ordinal)).toEqual([1, 2]);
  });

  it("does not clear streamBuffer", () => {
    useOutputStore.setState({
      history: [],
      streamBuffer: "ongoing stream content",
      toolProgress: [],
    });
    const block: ToolBlock = {
      toolName: "run_command",
      summary: "[Tools] run_command → npm test",
      preview: "PASS\n",
      fullResult: "PASS\nAll tests passed.",
      ok: true,
    };
    const store = useOutputStore.getState();
    store.logTool(block);

    const state = useOutputStore.getState();
    // streamBuffer unchanged
    expect(state.streamBuffer).toBe("ongoing stream content");
  });

  it("removes the matching transient tool progress line", () => {
    useOutputStore.setState({
      history: [],
      streamBuffer: "",
      toolProgress: ["[Tools] read_file -> src/a.ts", "[Tools] grep -> needle"],
    });
    const block: ToolBlock = {
      toolName: "read_file",
      summary: "[Tools] read_file -> src/a.ts",
      preview: "content",
      fullResult: "content",
      ok: true,
    };

    useOutputStore.getState().logTool(block);

    expect(useOutputStore.getState().toolProgress).toEqual(["[Tools] grep -> needle"]);
  });

  it("TOOL_FULL_CAP constant is defined and positive", () => {
    expect(TOOL_FULL_CAP).toBeGreaterThan(0);
  });
});

describe("appendStream", () => {
  it("batches stream updates into a timed flush", () => {
    vi.useFakeTimers();
    const store = useOutputStore.getState();

    store.appendStream("hel");
    store.appendStream("lo");

    expect(useOutputStore.getState().streamBuffer).toBe("");
    vi.advanceTimersByTime(49);
    expect(useOutputStore.getState().streamBuffer).toBe("");
    vi.advanceTimersByTime(1);
    expect(useOutputStore.getState().streamBuffer).toBe("hello");
  });

  it("commits completed stream lines into history and keeps the partial line transient", () => {
    vi.useFakeTimers();
    const store = useOutputStore.getState();

    store.appendStream("hello\nwor");
    vi.advanceTimersByTime(50);

    expect(useOutputStore.getState().history).toEqual([
      { id: "as_0", type: "assistant_stream", content: "hello\n" },
    ]);
    expect(useOutputStore.getState().streamBuffer).toBe("wor");
  });

  it("releases confirmed markdown tables into history once they terminate", () => {
    vi.useFakeTimers();
    const store = useOutputStore.getState();

    store.appendStream("Intro\n| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    vi.advanceTimersByTime(50);

    expect(useOutputStore.getState().history).toEqual([
      { id: "as_0", type: "assistant_stream", content: "Intro\n" },
    ]);
    expect(useOutputStore.getState().streamBuffer).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |\n");

    store.appendStream("\nAfter\n");
    vi.advanceTimersByTime(50);

    expect(useOutputStore.getState().history).toEqual([
      { id: "as_0", type: "assistant_stream", content: "Intro\n" },
      {
        id: "as_1",
        type: "assistant_stream",
        content: "| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter\n",
      },
    ]);
    expect(useOutputStore.getState().streamBuffer).toBe("");

    store.logAssistant("Intro\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter\n");

    expect(useOutputStore.getState().history).toEqual([
      { id: "as_0", type: "assistant_stream", content: "Intro\n" },
      {
        id: "as_1",
        type: "assistant_stream",
        content: "| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter\n",
      },
      {
        id: "a_2",
        type: "assistant",
        content: "Intro\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter\n",
        hidden: true,
      },
    ]);
    expect(useOutputStore.getState().streamBuffer).toBe("");
  });

  it("does not let a pending stream chunk reappear after assistant finalization", () => {
    vi.useFakeTimers();
    const store = useOutputStore.getState();

    store.appendStream("partial");
    store.logAssistant("final");
    vi.runOnlyPendingTimers();

    const state = useOutputStore.getState();
    expect(state.streamBuffer).toBe("");
    expect(state.history).toEqual([
      { id: "as_0", type: "assistant_stream", content: "final", final: true },
      { id: "a_1", type: "assistant", content: "final", hidden: true },
    ]);
  });

  it("logs a normal visible assistant turn when no stream preceded finalization", () => {
    useOutputStore.getState().logAssistant("final");

    expect(useOutputStore.getState().history).toEqual([
      { id: "a_0", type: "assistant", content: "final", hidden: false },
    ]);
  });
});

describe("clearHistory", () => {
  it("clears history, stream, and status", () => {
    useOutputStore.setState({
      history: [{ id: "a_1", type: "assistant", content: "hello" }],
      streamBuffer: "partial",
      toolProgress: ["[Tools] grep -> needle"],
      status: "Running…",
    });

    useOutputStore.getState().clearHistory();

    expect(useOutputStore.getState()).toMatchObject({
      history: [],
      streamBuffer: "",
      toolProgress: [],
      status: "Ready",
    });
  });

  it("moves wiped turns into clearedStaticTurns and keeps post-clear ids unique", () => {
    // Ink's <Static> counts flushed items in instance state; the combined
    // clearedStaticTurns + history array must only grow while Ink stays mounted,
    // or the post-clear turns (banner, token summary) are silently swallowed.
    const store = useOutputStore.getState();
    store.logUser("hello");
    store.logAssistant("hi there");
    const before = useOutputStore.getState().history;

    store.clearHistory();
    store.logBanner({ model: "m", dir: "d", version: "0.0.0" });
    store.logSystem("Token usage: total=1");

    const state = useOutputStore.getState();
    expect(state.clearedStaticTurns).toEqual(before);
    expect(state.history.map((turn) => turn.type)).toEqual(["banner", "system"]);
    const allIds = [...state.clearedStaticTurns, ...state.history].map((turn) => turn.id);
    expect(new Set(allIds).size).toBe(allIds.length);
  });
});
