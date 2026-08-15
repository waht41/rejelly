import path from "node:path";
import { describe, expect, it } from "vitest";
import { mapChangedPathsToPackages } from "../workspace.js";

describe("mapChangedPathsToPackages", () => {
  it("selects the deepest workspace owner and leaves root files unmapped", () => {
    const root = path.resolve("repo");
    expect(
      mapChangedPathsToPackages(
        root,
        [
          "package.json",
          "packages/create/src/index.ts",
          "packages/create/template-basic/src/index.ts",
          "packages/repo-tool/src/cli.ts",
        ],
        [
          { name: "create-rejelly", path: path.join(root, "packages/create") },
          { name: "template-basic", path: path.join(root, "packages/create/template-basic") },
          { name: "@rejelly/repo-tool", path: path.join(root, "packages/repo-tool") },
        ],
      ),
    ).toEqual({
      packages: ["@rejelly/repo-tool", "create-rejelly", "template-basic"],
      unmappedFiles: ["package.json"],
    });
  });
});
