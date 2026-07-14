import { describe, expect, it } from "vitest";

import { generateHexBytes } from "../crypto-random";

describe("generateHexBytes", () => {
  it("returns hex of expected length (2 chars per byte)", () => {
    expect(generateHexBytes(0)).toBe("");
    expect(generateHexBytes(1)).toMatch(/^[0-9a-f]{2}$/);
    expect(generateHexBytes(8)).toMatch(/^[0-9a-f]{16}$/);
    expect(generateHexBytes(16)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("produces different values across calls (best-effort)", () => {
    const a = generateHexBytes(16);
    const b = generateHexBytes(16);
    const c = generateHexBytes(16);
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
