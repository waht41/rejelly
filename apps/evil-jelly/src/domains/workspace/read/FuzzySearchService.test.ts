import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getWorkspaceRoot, setWorkspaceRoot } from "../../../shared/fs-policy/workspace-context";
import {
  fuzzySearchFiles,
  fuzzySearchPathRefs,
  getFuzzySearchCacheSize,
  resetFuzzySearchCache,
} from "./FuzzySearchService";

describe("FuzzySearchService", () => {
  let prevRoot: string;
  let tmpDir: string;

  beforeEach(async () => {
    prevRoot = getWorkspaceRoot();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "evil-jelly-fuzzy-service-"));
    await fs.mkdir(path.join(tmpDir, "src", "cli"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src", "cli", "SmartLinePrompt.tsx"), "// prompt\n");
    await fs.writeFile(path.join(tmpDir, "src", "cli", "FilePickerOverlay.tsx"), "// picker\n");
    setWorkspaceRoot(tmpDir);
    resetFuzzySearchCache();
  });

  afterEach(async () => {
    setWorkspaceRoot(prevRoot);
    resetFuzzySearchCache();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns workspace-relative paths and reuses cached candidates across queries", async () => {
    const first = await fuzzySearchFiles("smart", "src", 10);
    expect(first.map((match) => match.path)).toContain("src/cli/SmartLinePrompt.tsx");
    expect(getFuzzySearchCacheSize()).toBe(1);

    const second = await fuzzySearchFiles("picker", "src", 10);
    expect(second.map((match) => match.path)).toContain("src/cli/FilePickerOverlay.tsx");
    expect(getFuzzySearchCacheSize()).toBe(1);
  });

  it("refreshes a stale candidate snapshot on request", async () => {
    await fuzzySearchFiles("smart", ".", 10);
    const addedPath = path.join(tmpDir, "src", "cli", "NewNestedReport.md");
    await fs.writeFile(addedPath, "# new\n");

    await expect(fuzzySearchFiles("newnested", ".", 10)).resolves.toEqual([]);

    const refreshed = await fuzzySearchFiles("newnested", ".", 10, {
      cachePolicy: "refresh",
    });
    expect(refreshed.map((match) => match.path)).toContain("src/cli/NewNestedReport.md");
  });

  it("returns directories for attachable path refs", async () => {
    const matches = await fuzzySearchPathRefs("src/cli/", ".", 10);

    expect(matches).toContainEqual(expect.objectContaining({ path: "src/cli", kind: "directory" }));
    expect(matches).toContainEqual(
      expect.objectContaining({ path: "src/cli/SmartLinePrompt.tsx", kind: "file" }),
    );
  });

  it("rejects directories outside the workspace", async () => {
    await expect(fuzzySearchFiles("x", "..", 10)).rejects.toThrow(/outside workspace|not allowed/i);
  });

  it("returns empty results for an empty query without scanning", async () => {
    await expect(fuzzySearchFiles("   ", "src", 10)).resolves.toEqual([]);
  });
});
