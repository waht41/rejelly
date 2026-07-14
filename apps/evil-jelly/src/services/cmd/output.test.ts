import { describe, expect, it } from "vitest";
import { TRUNCATED_FOR_AGENT_MARKER, truncateOutput } from "./output";

describe("truncateOutput", () => {
  it("returns original text when within max bytes", () => {
    expect(truncateOutput("hello", 5)).toBe("hello");
    expect(truncateOutput("hello", 10)).toBe("hello");
  });

  it("keeps head and tail with marker when exceeding max bytes", () => {
    const source = "0123456789abcdefghijklmnopqrstuvwxyz";
    const out = truncateOutput(source, 10);
    expect(out).toContain(TRUNCATED_FOR_AGENT_MARKER);
    expect(out.startsWith("01234")).toBe(true);
    expect(out.endsWith("vwxyz")).toBe(true);
  });
});
