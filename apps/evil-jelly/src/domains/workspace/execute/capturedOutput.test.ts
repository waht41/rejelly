import { describe, expect, it } from "vitest";
import { BoundedCommandOutput } from "./capturedOutput";

describe("BoundedCommandOutput", () => {
  it("preserves output below and at the budget, including code points crossing the head/tail split", () => {
    const capture = new BoundedCommandOutput(16);
    expect(capture.snapshot().text).toBe("");
    capture.append("界😀");
    capture.append("界😀");
    expect(capture.snapshot()).toEqual({
      text: "界😀界😀",
      stats: { totalBytes: 14, retainedBytes: 14, omittedBytes: 0 },
    });
    capture.append("ab");
    expect(capture.snapshot().text).toBe("界😀界😀ab");
    expect(capture.snapshot().stats.omittedBytes).toBe(0);
  });

  it("rolls the shared suffix across many appends instead of retaining discarded chunks", () => {
    const capture = new BoundedCommandOutput(10);
    for (const part of ["0123", "4567", "89ab", "cdef", "ghij"]) capture.append(part);
    expect(capture.snapshot()).toEqual({
      text: "01234\n[evil-jelly: 10 UTF-8 bytes omitted by capture limit]\nfghij",
      stats: { totalBytes: 20, retainedBytes: 10, omittedBytes: 10 },
    });
    capture.append("abcdefghijklmnopqrst");
    expect(capture.snapshot().text).toBe(
      "01234\n[evil-jelly: 30 UTF-8 bytes omitted by capture limit]\npqrst",
    );
    expect(capture.snapshot().stats.retainedBytes).toBe(10);
  });

  it("drops partial UTF-8 code points at the gap and includes them in the loss count", () => {
    const capture = new BoundedCommandOutput(16);
    capture.append("界😀".repeat(6));
    expect(capture.snapshot()).toEqual({
      text: "界😀\n[evil-jelly: 28 UTF-8 bytes omitted by capture limit]\n界😀",
      stats: { totalBytes: 42, retainedBytes: 14, omittedBytes: 28 },
    });
  });
});
