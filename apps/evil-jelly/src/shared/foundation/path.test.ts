import path from "node:path";
import { describe, expect, it } from "vitest";
import { fromPosixPath, toPosixPath } from "./path";

describe("portable path conversion", () => {
  it("converts native separators to POSIX separators", () => {
    expect(toPosixPath("references\\nested\\guide.md")).toBe("references/nested/guide.md");
  });

  it("converts a validated POSIX path to native separators", () => {
    expect(fromPosixPath("references/nested/guide.md")).toBe(
      ["references", "nested", "guide.md"].join(path.sep),
    );
  });
});
