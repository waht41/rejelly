import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getWorkspaceRoot, setWorkspaceRoot } from "../../../shared/fs-policy/workspace-context";
import {
  fuzzySearchFiles,
  fuzzySearchPathRefs,
  fuzzySearchPathRefsWithContext,
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
    await fs.mkdir(path.join(tmpDir, "ignored", "deep"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "ignored", "empty"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".gitignore"), "ignored/\n.env\n");
    await fs.writeFile(path.join(tmpDir, "src", "cli", "SmartLinePrompt.tsx"), "// prompt\n");
    await fs.writeFile(path.join(tmpDir, "src", "cli", "FilePickerOverlay.tsx"), "// picker\n");
    await fs.writeFile(path.join(tmpDir, "ignored", "RootNote.md"), "# ignored root\n");
    await fs.writeFile(path.join(tmpDir, "ignored", "deep", "SecretPlan.md"), "# secret\n");
    await fs.writeFile(path.join(tmpDir, ".env"), "SECRET=value\n");
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

  it("keeps ignored paths hidden until an exact directory boundary is named", async () => {
    await expect(fuzzySearchPathRefs("secretplan", ".", 10)).resolves.toEqual([]);

    const exactDirectory = await fuzzySearchPathRefs("ignored", ".", 10);
    expect(exactDirectory[0]).toEqual({
      path: "ignored",
      score: Number.MAX_SAFE_INTEGER,
      kind: "directory",
      ignored: true,
    });
  });

  it("progressively searches within an exact ignored directory scope", async () => {
    const root = await fuzzySearchPathRefsWithContext("ignored/", ".", 10);
    expect(root).toEqual({
      ignoredScope: "ignored",
      matches: [
        { path: "ignored/deep", score: 0, kind: "directory", ignored: true },
        { path: "ignored/empty", score: 0, kind: "directory", ignored: true },
        { path: "ignored/RootNote.md", score: 0, kind: "file", ignored: true },
      ],
    });

    const nested = await fuzzySearchPathRefsWithContext("ignored/deep/sec", ".", 10);
    expect(nested.ignoredScope).toBe("ignored/deep");
    expect(nested.matches.map((match) => match.path)).toEqual(["ignored/deep/SecretPlan.md"]);
  });

  it("prepends an exact ignored file without exposing sensitive exact files", async () => {
    const exact = await fuzzySearchPathRefs("ignored/deep/SecretPlan.md", ".", 10);
    expect(exact[0]).toEqual({
      path: "ignored/deep/SecretPlan.md",
      score: Number.MAX_SAFE_INTEGER,
      kind: "file",
      ignored: true,
    });

    await expect(fuzzySearchPathRefs(".env", ".", 10)).resolves.toEqual([]);
  });

  it("rejects directories outside the workspace", async () => {
    await expect(fuzzySearchFiles("x", "..", 10)).rejects.toThrow(/outside workspace|not allowed/i);
  });

  it("returns empty results for an empty query without scanning", async () => {
    await expect(fuzzySearchFiles("   ", "src", 10)).resolves.toEqual([]);
  });
});
