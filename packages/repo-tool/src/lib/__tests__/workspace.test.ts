import path from "node:path";
import { describe, expect, it } from "vitest";
import { filterChangedPathsForPackages, mapChangedPathsToPackages } from "../workspace.js";

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

describe("filterChangedPathsForPackages", () => {
  it("keeps selected package and root files while excluding other workspace packages", () => {
    const root = path.resolve("repo");
    const packages = [
      { name: "app", path: path.join(root, "apps/app") },
      { name: "tool", path: path.join(root, "packages/tool") },
    ];

    expect(
      filterChangedPathsForPackages(
        root,
        ["package.json", "apps/app/src/index.ts", "packages/tool/src/index.ts"],
        packages,
        [packages[0]!],
      ),
    ).toEqual(["package.json", "apps/app/src/index.ts"]);
  });
});
