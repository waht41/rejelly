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
    await FuzzySearchTool.handler({ keyword: "seed", directory: "." });
    await fs.writeFile(path.join(workspace, "nested", "NewReport.md"), "# report\n");

    const result = await FuzzySearchTool.handler({ keyword: "newreport", directory: "." });

    expect(result).toContain("nested/NewReport.md");
  });
});
