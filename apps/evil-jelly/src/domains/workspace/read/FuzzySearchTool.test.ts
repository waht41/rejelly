import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getWorkspaceFsPolicy,
  setWorkspaceRoot,
} from "../../../shared/fs-policy/workspace-fs-policy";
import { resetFuzzySearchCache } from "./FuzzySearchService";
import { FuzzySearchTool } from "./FuzzySearchTool";

describe("FuzzySearchTool", () => {
  let previousRoot: string;
  let workspace: string;

  beforeEach(async () => {
    previousRoot = getWorkspaceFsPolicy().getRoot();
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "evil-jelly-fuzzy-tool-"));
    await fs.mkdir(path.join(workspace, "nested"), { recursive: true });
    await fs.writeFile(path.join(workspace, "seed.txt"), "seed\n");
    setWorkspaceRoot(workspace);
    resetFuzzySearchCache();
  });

  afterEach(async () => {
    setWorkspaceRoot(previousRoot);
    resetFuzzySearchCache();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("refreshes candidates on every tool invocation", async () => {
    await FuzzySearchTool.handler({ keyword: "seed", directory: ".", includeIgnored: false });
    await fs.writeFile(path.join(workspace, "nested", "NewReport.md"), "# report\n");

    const result = await FuzzySearchTool.handler({
      keyword: "newreport",
      directory: ".",
      includeIgnored: false,
    });

    expect(result).toContain("nested/NewReport.md");
  });

  it("returns ranked paths for a fuzzy needle", async () => {
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src", "FuzzyMatchMe.ts"), "// probe\n");

    const args = FuzzySearchTool.parameters.parse({
      keyword: "FuzzyMtch",
      directory: ".",
      limit: 10,
    });
    const result = await FuzzySearchTool.handler(args);

    expect(result, String(result)).not.toMatch(/^fuzzy_search_paths failed:/);
    expect(typeof result).toBe("string");
    expect(result).toContain("FuzzyMatchMe.ts");
  });

  it("rejects paths outside workspace", async () => {
    const args = FuzzySearchTool.parameters.parse({
      keyword: "x",
      directory: "..",
      limit: 5,
    });
    const result = await FuzzySearchTool.handler(args);

    expect(result).toMatch(/escape|working directory|not allowed/i);
  });

  it("searches one explicit ignored subtree", async () => {
    await fs.mkdir(path.join(workspace, "local", "nested"), { recursive: true });
    await fs.writeFile(path.join(workspace, ".gitignore"), "local/\n", "utf8");
    await fs.writeFile(path.join(workspace, "local", "nested", "IgnoredReport.md"), "# report\n");
    setWorkspaceRoot(workspace);

    const result = await FuzzySearchTool.handler({
      keyword: "ignoredreport",
      directory: "local",
      includeIgnored: true,
    });

    expect(result).toContain("local/nested/IgnoredReport.md");
  });

  it("requires ignored scans to use a bounded subtree and concrete dependency package", async () => {
    await fs.mkdir(path.join(workspace, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(workspace, ".gitignore"), "node_modules/\n", "utf8");
    await fs.writeFile(path.join(workspace, "node_modules", "pkg", "DependencyTypes.d.ts"), "");
    setWorkspaceRoot(workspace);

    const workspaceWide = await FuzzySearchTool.handler({
      keyword: "types",
      directory: ".",
      includeIgnored: true,
    });
    const dependencyRoot = await FuzzySearchTool.handler({
      keyword: "types",
      directory: "node_modules",
      includeIgnored: true,
    });
    const packageResult = await FuzzySearchTool.handler({
      keyword: "types",
      directory: "node_modules/pkg",
      includeIgnored: true,
    });

    expect(workspaceWide).toContain("explicit workspace subdirectory");
    expect(dependencyRoot).toContain("concrete package");
    expect(packageResult).toContain("node_modules/pkg/DependencyTypes.d.ts");
  });
});
