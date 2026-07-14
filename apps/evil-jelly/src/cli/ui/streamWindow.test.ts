import { describe, expect, it } from "vitest";
import {
  createStreamTailWindow,
  displayWidth,
  measureStreamRows,
  measureWrappedRows,
} from "./streamWindow";

describe("stream window measurement", () => {
  it("uses terminal cell width for CJK and emoji", () => {
    expect(displayWidth("孤立")).toBe(4);
    expect(displayWidth("✅仍在使用")).toBe(10);
  });

  it("measures wrapped rows with hard wrapping", () => {
    expect(measureWrappedRows("abcdef", 3)).toBe(2);
    expect(measureWrappedRows("孤立abc", 3)).toBe(3);
  });

  it("keeps a markdown stream inside the requested row budget", () => {
    const text = [
      "# heading",
      "",
      "first paragraph",
      "",
      "| Name | Count |",
      "| --- | --- |",
      "| alpha | 1 |",
      "| beta | 2 |",
      "",
      "final line",
    ].join("\n");

    const window = createStreamTailWindow({
      text,
      columns: 20,
      maxRows: 4,
    });

    expect(window.clipped).toBe(true);
    expect(window.measuredRows).toBeLessThanOrEqual(4);
    expect(measureStreamRows(window.text, 20)).toBeLessThanOrEqual(4);
    expect(window.text).toContain("final line");
  });

  it("falls back to a raw visual suffix for a single overlong line", () => {
    const window = createStreamTailWindow({
      text: "abcdefghijklmnopqrstuvwxyz",
      columns: 5,
      maxRows: 2,
    });

    expect(window.clipped).toBe(true);
    expect(window.forceRaw).toBe(true);
    expect(measureWrappedRows(window.text, 5)).toBeLessThanOrEqual(2);
    expect(window.text).toBe("uvwxy\nz");
  });
});
