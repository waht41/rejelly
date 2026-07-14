import { describe, expect, it } from "vitest";
import { fnv1a32Hex } from "./hash";

describe("fnv1a32Hex", () => {
  it("returns a stable 8-character unsigned hex digest", () => {
    expect(fnv1a32Hex("hello")).toBe("4f9f2cab");
    expect(fnv1a32Hex("")).toBe("811c9dc5");
  });
});
