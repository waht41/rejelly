import { describe, expect, it } from "vitest";
import {
  composeToolTailWindow,
  drainToolOutput,
  type RunningToolTail,
  toDisplayLine,
} from "./tailWindow";

const tool = (ordinal: number, tail: string[], partial = ""): RunningToolTail => ({
  ordinal,
  tail,
  partial,
});
const texts = (rows: ReturnType<typeof composeToolTailWindow>) => rows.map((row) => row.text);

describe("drainToolOutput", () => {
  it("emits complete lines and holds the unterminated remainder", () => {
    expect(drainToolOutput("a\nb\nc")).toEqual({ lines: ["a", "b"], rest: "c" });
  });

  it("reassembles a line split across chunk boundaries", () => {
    const first = drainToolOutput("hel");
    expect(first).toEqual({ lines: [], rest: "hel" });
    expect(drainToolOutput(`${first.rest}lo\n`)).toEqual({ lines: ["hello"], rest: "" });
  });

  it("normalizes CRLF without leaving a stray carriage return", () => {
    expect(drainToolOutput("a\r\nb\r\n").lines).toEqual(["a", "b"]);
  });

  it("keeps only the last segment of an overwritten progress line", () => {
    expect(drainToolOutput("10%\r50%\r100%\n").lines).toEqual(["100%"]);
  });

  it("collapses an unterminated progress bar so the buffer cannot grow", () => {
    expect(drainToolOutput("10%\r50%\r75%").rest).toBe("75%");
  });

  it("strips colors and drops blank lines", () => {
    expect(drainToolOutput("[31mred[0m\n\n   \nnext\n").lines).toEqual(["red", "next"]);
  });

  it("caps a runaway line", () => {
    expect(drainToolOutput(`${"x".repeat(900)}\n`).lines[0]).toHaveLength(512);
    expect(drainToolOutput("y".repeat(900)).rest).toHaveLength(512);
  });
});

describe("toDisplayLine", () => {
  it("cleans a raw partial line for display", () => {
    expect(toDisplayLine("busy\r[32mdone[0m   ")).toBe("done");
  });
});

describe("composeToolTailWindow", () => {
  it("gives the whole window to a single tool, newest rows last", () => {
    expect(texts(composeToolTailWindow([tool(1, ["a", "b", "c", "d"])], 3))).toEqual([
      "b",
      "c",
      "d",
    ]);
  });

  it("shows the unterminated partial as the newest row", () => {
    expect(texts(composeToolTailWindow([tool(1, ["a"], "in progress")], 3))).toEqual([
      "a",
      "in progress",
    ]);
  });

  it("splits the window fairly so a chatty tool cannot evict a quiet one", () => {
    const chatty = tool(1, ["1", "2", "3", "4", "5", "6", "7", "8"]);
    const quiet = tool(2, ["only"]);
    const rows = composeToolTailWindow([chatty, quiet], 4);
    expect(rows).toEqual([
      { ordinal: 1, text: "6" },
      { ordinal: 1, text: "7" },
      { ordinal: 1, text: "8" },
      { ordinal: 2, text: "only" },
    ]);
  });

  it("spends leftover rows on whoever still has output", () => {
    // The quiet tool can only fill one row, so the other three go to the chatty one.
    expect(
      texts(composeToolTailWindow([tool(1, ["a", "b", "c", "d", "e"]), tool(2, ["x"])], 4)),
    ).toEqual(["c", "d", "e", "x"]);
  });

  it("groups rows by tool and orders groups by ordinal", () => {
    const rows = composeToolTailWindow([tool(7, ["b1", "b2"]), tool(3, ["a1", "a2"])], 4);
    expect(rows.map((row) => row.ordinal)).toEqual([3, 3, 7, 7]);
  });

  it("still shows one row each when the window is smaller than the tool count", () => {
    const rows = composeToolTailWindow([tool(1, ["a"]), tool(2, ["b"]), tool(3, ["c"])], 2);
    expect(rows).toEqual([
      { ordinal: 1, text: "a" },
      { ordinal: 2, text: "b" },
    ]);
  });

  it("ignores tools with nothing to show", () => {
    expect(composeToolTailWindow([tool(1, []), tool(2, ["x"])], 3)).toEqual([
      { ordinal: 2, text: "x" },
    ]);
  });

  it("is empty without rows to spend", () => {
    expect(composeToolTailWindow([tool(1, ["a"])], 0)).toEqual([]);
    expect(composeToolTailWindow([], 3)).toEqual([]);
  });
});
