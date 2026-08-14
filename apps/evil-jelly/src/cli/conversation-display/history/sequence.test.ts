import { describe, expect, it } from "vitest";
import { HistorySequence } from "./sequence";

describe("HistorySequence", () => {
  it("keeps turn ids unique while restarting addressable tool ordinals", () => {
    const sequence = new HistorySequence();

    expect(sequence.nextTurnId("user")).toBe("u_0");
    expect(sequence.nextToolOrdinal()).toBe(1);
    sequence.resetToolOrdinals();

    expect(sequence.nextTurnId("system")).toBe("s_1");
    expect(sequence.nextToolOrdinal()).toBe(1);
  });

  it("resets both sequences for a new CLI session", () => {
    const sequence = new HistorySequence();
    sequence.nextTurnId("tool");
    sequence.nextToolOrdinal();
    sequence.reset();

    expect(sequence.nextTurnId("banner")).toBe("b_0");
    expect(sequence.nextToolOrdinal()).toBe(1);
  });
});
