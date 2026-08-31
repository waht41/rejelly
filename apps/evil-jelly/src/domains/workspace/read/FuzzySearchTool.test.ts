import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getWorkspaceFsPolicy,
  setWorkspaceRoot,
} from "../../../shared/fs-policy/workspace-fs-policy";
import type { EvilJellyBindings } from "../../../shared/host/bindings";
import type { FsOutsideAccessPayload } from "../../../shared/host/toolConfirmationBindings";
import { createTestHostBindings } from "../__tests__/testHostBindings";
import { resetFuzzySearchCache } from "./FuzzySearchService";
import { FuzzySearchTool } from "./FuzzySearchTool";

const hostBindingMock = vi.hoisted(() => ({
  current: null as EvilJellyBindings | null,
}));

vi.mock("../../../shared/host/context", () => ({
  getBinding: () => {
    if (!hostBindingMock.current) {
      throw new Error("No test host binding registered.");
    }
    return hostBindingMock.current;
  },
}));

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
    hostBindingMock.current = null;
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

  it("confirms and searches paths outside the workspace", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "evil-jelly-outside-fuzzy-"));
    const outsideFile = path.join(outsideDir, "ExternalReport.md");
    await fs.writeFile(outsideFile, "# outside\n", "utf8");
    const outsideAccessRequests: FsOutsideAccessPayload[] = [];
    hostBindingMock.current = createTestHostBindings({ mode: "normal", outsideAccessRequests });
    const args = FuzzySearchTool.parameters.parse({
      keyword: "externalreport",
      directory: outsideDir,
      limit: 5,
    });

    try {
      const result = await FuzzySearchTool.handler(args);

      expect(outsideAccessRequests).toHaveLength(1);
      expect(outsideAccessRequests[0]?.access).toBe("scan");
      expect(result).toContain(outsideFile.replace(/\\/g, "/"));
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
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
