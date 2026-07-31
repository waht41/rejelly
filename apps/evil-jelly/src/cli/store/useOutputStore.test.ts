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
    expect(isRuntimeActive("idle", "")).toBe(false);
    expect(isRuntimeActive("awaiting_user", "")).toBe(false);
  });

  it("treats every in-flight phase and leftover stream output as active runtime work", () => {
    expect(isRuntimeActive("connecting", "")).toBe(true);
    expect(isRuntimeActive("thinking", "")).toBe(true);
    expect(isRuntimeActive("streaming", "")).toBe(true);
    expect(isRuntimeActive("compacting", "")).toBe(true);
    expect(isRuntimeActive("tool", "")).toBe(true);
    expect(isRuntimeActive("working", "")).toBe(true);
    expect(isRuntimeActive("idle", "partial output")).toBe(true);
  });

  it("ignores the status detail entirely", () => {
    // The detail used to decide this by its "Waiting for " prefix, so every new status string
    // was a chance to report a busy agent idle and blank the transient view mid-run.
    useOutputStore.getState().setPhase("connecting", "Waiting for review comments…");
    const state = useOutputStore.getState();
    expect(isRuntimeActive(state.runtime.phase, state.streamBuffer)).toBe(true);
  });
});

describe("setPhase", () => {
  it("restarts the elapsed timer only when the phase actually changes", () => {
    const store = useOutputStore.getState();
    store.setPhase("connecting");
    const since = useOutputStore.getState().runtime.phaseSince;

    // Stream deltas re-announce the same phase dozens of times a second; if each one rebased
    // phaseSince the counter would sit at 0s and never expose a stall.
    store.setPhase("connecting");
    expect(useOutputStore.getState().runtime.phaseSince).toBe(since);

    store.setPhase("streaming");
    expect(useOutputStore.getState().runtime.phaseSince).toBeGreaterThanOrEqual(since);
    expect(useOutputStore.getState().runtime.phase).toBe("streaming");
  });

  it("carries the status detail without letting it drive the phase", () => {
    useOutputStore.getState().setPhase("awaiting_user", "shell → workspace root");
    expect(useOutputStore.getState().runtime.detail).toBe("shell → workspace root");
    expect(useOutputStore.getState().runtime.phase).toBe("awaiting_user");

    useOutputStore.getState().setDetail("outside read → /etc/hosts");
    expect(useOutputStore.getState().runtime.phase).toBe("awaiting_user");
  });

  it("returns to idle at a turn boundary", () => {
    useOutputStore.getState().setPhase("streaming");
    useOutputStore.getState().logAssistant("done");
    expect(useOutputStore.getState().runtime.phase).toBe("idle");
    expect(useOutputStore.getState().runtime.detail).toBe("Ready");
  });
});

describe("turn timing", () => {
  it("anchors the timer on beginTurn and survives phase changes", () => {
    const store = useOutputStore.getState();
    store.beginTurn();
    const startedAt = useOutputStore.getState().runtime.turnStartedAt;
    expect(startedAt).not.toBeNull();

    // Phase transitions (connecting → thinking → streaming) never move the anchor.
    store.setPhase("connecting");
    store.setPhase("thinking");
    store.setPhase("streaming");
    expect(useOutputStore.getState().runtime.turnStartedAt).toBe(startedAt);
  });

  it("is idempotent: a second beginTurn does not restart the timer", () => {
    const store = useOutputStore.getState();
    store.beginTurn();
    const startedAt = useOutputStore.getState().runtime.turnStartedAt;

    store.beginTurn();
    expect(useOutputStore.getState().runtime.turnStartedAt).toBe(startedAt);
  });

  it("does not anchor the timer from setPhase or beginTool alone", () => {
    const store = useOutputStore.getState();
    store.setPhase("working");
    store.beginTool({ toolName: "read_file", summary: "[Tools] read a" });
    // A tool without an initial input (e.g. a maintenance flow) is not a turn.
    expect(useOutputStore.getState().runtime.turnStartedAt).toBeNull();
  });

  it("does not reset the turn timer on a mid-turn confirmation wait", () => {
    const store = useOutputStore.getState();
    store.beginTurn();
    const startedAt = useOutputStore.getState().runtime.turnStartedAt;

    // confirmWrite pauses the same turn for the user; the timer must keep counting.
    store.setPhase("awaiting_user", "shell → workspace root");
    expect(useOutputStore.getState().runtime.turnStartedAt).toBe(startedAt);

    store.setPhase("working", "Running…");
    expect(useOutputStore.getState().runtime.turnStartedAt).toBe(startedAt);
  });

  it("ends the timer at the turn boundary and restarts fresh for the next turn", () => {
    const store = useOutputStore.getState();
    store.beginTurn();
    store.setPhase("streaming");
    store.logAssistant("done");
    expect(useOutputStore.getState().runtime.turnStartedAt).toBeNull();

    store.beginTurn();
    expect(useOutputStore.getState().runtime.turnStartedAt).not.toBeNull();
  });

  it("logs the turn duration as a one-line system notice after the reply", () => {
    const store = useOutputStore.getState();
    store.beginTurn();
    store.setPhase("streaming");
    store.logAssistant("done");

    const history = useOutputStore.getState().history;
    expect(history[history.length - 2]).toMatchObject({ type: "assistant", content: "done" });
    const timing = history[history.length - 1]!;
    expect(timing.type).toBe("system");
    if (timing.type === "system") {
      expect(timing.content).toMatch(/^Turn took \d+(\.\d+)?s$/);
      expect(timing.oneLine).toBe(true);
    }
  });

  it("skips the timing line when no turn ran (hydrated/resumed session)", () => {
    useOutputStore.getState().logAssistant("done");
    expect(useOutputStore.getState().history).toEqual([
      { id: "a_0", type: "assistant", content: "done", hidden: false },
    ]);
  });
});

describe("tool phase", () => {
  it("holds one timer across a parallel batch and releases it when the last tool ends", () => {
    const store = useOutputStore.getState();
    store.setPhase("working");
    const first = store.beginTool({ toolName: "read_file", summary: "[Tools] read a" });
    expect(useOutputStore.getState().runtime.phase).toBe("tool");
    const batchSince = useOutputStore.getState().runtime.phaseSince;

    // A second concurrent call joins the running batch; restarting here would make the counter
    // measure the newest tool instead of how long the batch has been going.
    const second = store.beginTool({ toolName: "read_file", summary: "[Tools] read b" });
    expect(useOutputStore.getState().runtime.phaseSince).toBe(batchSince);

    store.logTool({
      id: first.id,
      ordinal: first.ordinal,
      toolName: "read_file",
      summary: "[Tools] read a",
      preview: "a",
      fullResult: "a",
      ok: true,
    });
    expect(useOutputStore.getState().runtime.phase).toBe("tool");

    store.logTool({
      id: second.id,
      ordinal: second.ordinal,
      toolName: "read_file",
      summary: "[Tools] read b",
      preview: "b",
      fullResult: "b",
      ok: true,
    });
    expect(useOutputStore.getState().runtime.phase).toBe("working");
  });
});

describe("logTool", () => {
  it("adds a tool turn to history with summary as content", () => {
    useOutputStore.setState({ history: [], runningTools: [] });
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
      runningTools: [],
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

  it("drops only the finished call from the live view, matching on id not summary", () => {
    const store = useOutputStore.getState();
    // Two calls that look identical — the old summary match would have removed
    // whichever came first, leaving a running tool invisible.
    const first = store.beginTool({ toolName: "read_file", summary: "[Tools] read_file -> a.ts" });
    const second = store.beginTool({ toolName: "read_file", summary: "[Tools] read_file -> a.ts" });

    store.logTool({
      id: second.id,
      ordinal: second.ordinal,
      toolName: "read_file",
      summary: "[Tools] read_file -> a.ts",
      preview: "content",
      fullResult: "content",
      ok: true,
    });

    expect(useOutputStore.getState().runningTools.map((tool) => tool.id)).toEqual([first.id]);
  });

  it("numbers calls when they start, so parallel tools keep invocation order", () => {
    const store = useOutputStore.getState();
    const first = store.beginTool({ toolName: "run_command", summary: "[Tools] slow" });
    const second = store.beginTool({ toolName: "run_command", summary: "[Tools] fast" });
    expect([first.ordinal, second.ordinal]).toEqual([1, 2]);

    // The second call finishes first; its block must still read #2.
    const block = (handle: typeof first, summary: string): ToolBlock => ({
      id: handle.id,
      ordinal: handle.ordinal,
      toolName: "run_command",
      summary,
      preview: "",
      fullResult: "",
      ok: true,
    });
    store.logTool(block(second, "[Tools] fast"));
    store.logTool(block(first, "[Tools] slow"));

    const ordinals = useOutputStore
      .getState()
      .history.filter(
        (turn): turn is Extract<typeof turn, { type: "tool" }> => turn.type === "tool",
      )
      .map((turn) => turn.tool.ordinal);
    expect(ordinals).toEqual([2, 1]);
  });

  it("accumulates live output into the running tool's tail", async () => {
    const store = useOutputStore.getState();
    const handle = store.beginTool({ toolName: "run_command", summary: "[Tools] build" });

    store.appendToolOutput(handle.id, "compiling\nlinking");
    await vi.waitFor(() => {
      const tool = useOutputStore.getState().runningTools[0]!;
      expect(tool.tail).toEqual(["compiling"]);
      expect(tool.partial).toBe("linking");
      expect(tool.lineCount).toBe(1);
    });
  });

  it("TOOL_FULL_CAP constant is defined and positive", () => {
    expect(TOOL_FULL_CAP).toBeGreaterThan(0);
  });

  it("resumes as 'tool' when a confirmation paused a running tool batch", () => {
    const store = useOutputStore.getState();
    store.beginTurn();
    store.beginTool({ toolName: "run_command", summary: "[Tools] build" });

    // confirmWrite pauses the turn for the user…
    store.setPhase("awaiting_user", "shell → workspace root");
    expect(useOutputStore.getState().runtime.phase).toBe("awaiting_user");

    // …and resumeWork must restore the tool phase, not a generic "working".
    store.resumeWork("Running…");
    expect(useOutputStore.getState().runtime.phase).toBe("tool");
  });

  it("resumes as 'working' when no tool is running", () => {
    const store = useOutputStore.getState();
    store.resumeWork("Running…");
    expect(useOutputStore.getState().runtime.phase).toBe("working");
  });

  it("survives a system notice logged while the tool runs", async () => {
    // Every auto-allowed confirmation lands here, between beginTool and the
    // first chunk. Treating it as a turn boundary retired the tool before it had
    // printed anything, so the live view stayed empty for the whole command.
    const store = useOutputStore.getState();
    store.setDetail("Running…");
    const handle = store.beginTool({ toolName: "run_command", summary: "[Tools] stream" });

    store.logSystem("[Auto-allowed] declared read_only → node stream-test.js");

    expect(useOutputStore.getState().runningTools.map((tool) => tool.id)).toEqual([handle.id]);
    expect(useOutputStore.getState().runtime.detail).toBe("Running…");
    expect(useOutputStore.getState().runtime.phase).toBe("tool");

    store.appendToolOutput(handle.id, "line 1\n");
    await vi.waitFor(() => {
      expect(useOutputStore.getState().runningTools[0]?.tail).toEqual(["line 1"]);
    });
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

  it("stamps the last output time on every flushed stream chunk", () => {
    vi.useFakeTimers();
    const store = useOutputStore.getState();
    const before = useOutputStore.getState().runtime.lastOutputAt;

    store.appendStream("hel");
    vi.advanceTimersByTime(50);

    // The streaming-stall check reads this: a long answer keeps refreshing it, silence does not.
    expect(useOutputStore.getState().runtime.lastOutputAt).toBeGreaterThan(before);
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
      runningTools: [],
      runtime: {
        detail: "Running…",
        phase: "working",
        phaseSince: Date.now(),
        turnStartedAt: null,
        lastOutputAt: Date.now(),
      },
    });

    useOutputStore.getState().clearHistory();

    expect(useOutputStore.getState()).toMatchObject({
      history: [],
      streamBuffer: "",
      runningTools: [],
      runtime: { detail: "Ready", phase: "idle" },
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
