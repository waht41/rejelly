import { describe, expect, it } from "vitest";
import { parseNameStatusPaths } from "../changes.js";

describe("parseNameStatusPaths", () => {
  it("retains both sides of renames and copies for package impact mapping", () => {
    expect(
      parseNameStatusPaths([
        "M",
        "packages/a/src/a.ts",
        "R100",
        "packages/a/src/old.ts",
        "packages/b/src/new.ts",
        "C90",
        "packages/b/src/source.ts",
        "packages/c/src/copy.ts",
      ]),
    ).toEqual([
      "packages/a/src/a.ts",
      "packages/a/src/old.ts",
      "packages/b/src/new.ts",
      "packages/b/src/source.ts",
      "packages/c/src/copy.ts",
    ]);
  });
});
