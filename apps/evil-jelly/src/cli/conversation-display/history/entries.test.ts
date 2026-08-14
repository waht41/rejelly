import { describe, expect, it } from "vitest";
import { assistantCompletionTurns } from "./entries";
import { HistorySequence } from "./sequence";

describe("assistantCompletionTurns", () => {
  it("preserves the visible stream remainder before a hidden final reply", () => {
    const turns = assistantCompletionTurns(new HistorySequence(), {
      content: "complete reply",
      visualRemainder: "visible tail",
      shouldHideFinal: true,
      durationMs: 92_345,
    });

    expect(turns).toEqual([
      { id: "as_0", type: "assistant_stream", content: "visible tail", final: true },
      { id: "a_1", type: "assistant", content: "complete reply", hidden: true },
      { id: "s_2", type: "system", content: "Worked for 1m 32s", oneLine: true },
    ]);
  });

  it("omits timing evidence when no live turn was running", () => {
    expect(
      assistantCompletionTurns(new HistorySequence(), {
        content: "resumed reply",
        visualRemainder: "",
        shouldHideFinal: false,
        durationMs: null,
      }),
    ).toEqual([{ id: "a_0", type: "assistant", content: "resumed reply", hidden: false }]);
  });
});
