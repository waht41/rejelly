import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantStreamFlush } from "./buffer";
import { AssistantStreamBuffer } from "./buffer";

afterEach(() => vi.useRealTimers());

describe("AssistantStreamBuffer", () => {
  it("batches deltas and publishes the stable history fragment with its live tail", () => {
    vi.useFakeTimers();
    const flushes: AssistantStreamFlush[] = [];
    const buffer = new AssistantStreamBuffer((flush) => flushes.push(flush));
    buffer.append("hello\nwor");

    expect(flushes).toEqual([]);
    vi.advanceTimersByTime(50);

    expect(flushes).toEqual([{ stableText: "hello\n", tailText: "wor" }]);
  });

  it("drains held-back Markdown before an interruption", () => {
    const flushes: AssistantStreamFlush[] = [];
    const buffer = new AssistantStreamBuffer((flush) => flushes.push(flush));
    buffer.append("- first\n- second\n");

    expect(buffer.drain()).toBe("- first\n- second\n");
    expect(flushes).toEqual([{ stableText: "", tailText: "- first\n- second\n" }]);
  });

  it("bounds only the transient tail", () => {
    const flushes: AssistantStreamFlush[] = [];
    const buffer = new AssistantStreamBuffer((flush) => flushes.push(flush), { transientCap: 4 });
    buffer.append("abcdef");
    buffer.flush();

    expect(flushes).toEqual([{ stableText: "", tailText: "cdef" }]);
  });

  it("cancels pending work when reset", () => {
    vi.useFakeTimers();
    const flushes: AssistantStreamFlush[] = [];
    const buffer = new AssistantStreamBuffer((flush) => flushes.push(flush));
    buffer.append("discard me");

    buffer.reset();
    vi.runAllTimers();

    expect(flushes).toEqual([]);
  });
});
