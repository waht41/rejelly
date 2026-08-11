/**
 * Integration test: fuzzy_search_paths runs on git ls-files (or the Node walk fallback) — no native addon.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FuzzySearchTool } from "../domains/workspace/read/FuzzySearchTool";
import { getWorkspaceFsPolicy, setWorkspaceRoot } from "../shared/fs-policy/workspace-fs-policy";

describe("fuzzy_search_paths tool", () => {
  let prevRoot: string;
  let tmpDir: string;

  beforeEach(async () => {
    prevRoot = getWorkspaceFsPolicy().getRoot();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "evil-jelly-fuzzy-"));
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src", "FuzzyMatchMe.ts"), "// probe\n", "utf8");
    await fs.writeFile(path.join(tmpDir, "README.md"), "# x\n", "utf8");
    setWorkspaceRoot(tmpDir);
  });

  afterEach(async () => {
    setWorkspaceRoot(prevRoot);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns ranked paths for a fuzzy needle", async () => {
    const args = FuzzySearchTool.parameters.parse({
      keyword: "FuzzyMtch",
      directory: ".",
      limit: 10,
    });
    const out = await FuzzySearchTool.handler(args);
    expect(out, String(out)).not.toMatch(/^fuzzy_search_paths failed:/);
    expect(typeof out).toBe("string");
    expect(out as string).toContain("FuzzyMatchMe.ts");
  });

  it("rejects paths outside workspace", async () => {
    const args = FuzzySearchTool.parameters.parse({
      keyword: "x",
      directory: "..",
      limit: 5,
    });
    const out = await FuzzySearchTool.handler(args);
    expect(out).toMatch(/escape|working directory|not allowed/i);
  });
});
