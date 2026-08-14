import { afterEach, describe, expect, it, vi } from "vitest";
import { RunningToolOutputBuffer } from "./outputBuffer";
import type { ToolOutputDrain } from "./tailWindow";

afterEach(() => vi.useRealTimers());

describe("RunningToolOutputBuffer", () => {
  it("batches chunks per tool and preserves partial lines", () => {
    vi.useFakeTimers();
    const flushes: ReadonlyMap<string, ToolOutputDrain>[] = [];
    const buffer = new RunningToolOutputBuffer((drained) => flushes.push(drained));
    buffer.append("a", "one\ntw");
    buffer.append("a", "o");
    buffer.append("b", "other\n");
    vi.advanceTimersByTime(50);

    expect(flushes[0]?.get("a")).toEqual({ lines: ["one"], rest: "two" });
    expect(flushes[0]?.get("b")).toEqual({ lines: ["other"], rest: "" });
  });

  it("discards pending output for a completed tool", () => {
    vi.useFakeTimers();
    const flushes: ReadonlyMap<string, ToolOutputDrain>[] = [];
    const buffer = new RunningToolOutputBuffer((drained) => flushes.push(drained));
    buffer.append("a", "stale\n");
    buffer.discard("a");
    vi.runAllTimers();

    expect(flushes).toEqual([]);
  });
});
