import { describe, expect, it } from "vitest";
import {
  MAX_OUTPUT_LINE_BYTES,
  TRUNCATED_FOR_AGENT_MARKER,
  truncateLongLines,
  truncateOutput,
} from "./output";

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

  it("limits long lines before applying the total output limit", () => {
    const source = `before\n${"x".repeat(MAX_OUTPUT_LINE_BYTES * 2)}\nafter`;
    const out = truncateOutput(source, 48_000);
    const lines = out.split("\n");

    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("before");
    expect(lines[1]).toContain("[LINE TRUNCATED FOR AGENT:");
    expect(Buffer.byteLength(lines[1], "utf8")).toBeLessThanOrEqual(MAX_OUTPUT_LINE_BYTES);
    expect(lines[2]).toBe("after");
    expect(out).not.toContain(TRUNCATED_FOR_AGENT_MARKER);
  });
});

describe("truncateLongLines", () => {
  it("preserves line endings and UTF-8 boundaries while keeping each line within the limit", () => {
    const source = `${"界".repeat(100)}\r\nshort\n${"z".repeat(200)}`;
    const out = truncateLongLines(source, 64);
    const lines = out.split(/\r?\n/);

    expect(out).toContain("\r\n");
    expect(lines[1]).toBe("short");
    expect(lines[0]).toContain("[LINE TRUNCATED FOR AGENT:");
    expect(lines[2]).toContain("[LINE TRUNCATED FOR AGENT:");
    expect(lines.every((line) => Buffer.byteLength(line, "utf8") <= 64)).toBe(true);
    expect(out).not.toContain("�");
  });
});
