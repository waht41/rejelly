import { describe, expect, it } from "vitest";
import { getErrnoCode } from "./errno";

describe("getErrnoCode", () => {
  it("returns a Node errno code from object-shaped errors", () => {
    expect(getErrnoCode(Object.assign(new Error("exists"), { code: "EEXIST" }))).toBe("EEXIST");
  });

  it("returns undefined for values without an errno code", () => {
    expect(getErrnoCode(new Error("plain"))).toBeUndefined();
    expect(getErrnoCode("boom")).toBeUndefined();
    expect(getErrnoCode(null)).toBeUndefined();
  });
});
