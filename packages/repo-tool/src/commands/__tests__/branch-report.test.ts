import { describe, expect, it } from "vitest";
import type { BranchReport } from "../../contracts.js";
import {
  formatBranchReport,
  parseCommits,
  parseDiffStat,
  parseWorkingTreeChanges,
} from "../branch-report.js";

describe("branch report", () => {
  it("parses commit subjects without interpreting their text", () => {
    expect(parseCommits("abc123\tfeat: one\ndef456\tfix: preserve\ttabs")).toEqual([
      { shortSha: "abc123", subject: "feat: one" },
      { shortSha: "def456", subject: "fix: preserve\ttabs" },
    ]);
  });

  it("aggregates text and binary numstat entries", () => {
    expect(parseDiffStat("3\t1\ta.ts\n-\t-\timage.png\n2\t0\tb.ts")).toEqual({
      binary: 1,
      deletions: 1,
      files: 3,
      insertions: 5,
    });
  });

  it("formats the full branch state from one persisted report", () => {
    const report: BranchReport = {
      ahead: 1,
      base: "origin/main",
      behind: 0,
      branch: "feat/tool",
      commits: [{ shortSha: "abc123", subject: "feat: tool" }],
      commitsTruncated: false,
      diff: { binary: 0, deletions: 2, files: 2, insertions: 10 },
      head: "abc123456789",
      mergeBase: "def456789012",
      schemaVersion: 2,
      upstream: "origin/feat/tool",
      workingTree: [
        { indexStatus: "M", path: "package.json" },
        { path: "packages/repo-tool/package.json", untracked: true },
      ],
    };
    expect(formatBranchReport(report)).toContain("changes: staged 1, unstaged 0, untracked 1");
    expect(formatBranchReport(report)).toContain("abc123 feat: tool");
  });

  it("preserves dual index/worktree state, untracked files, and rename provenance", () => {
    expect(
      parseWorkingTreeChanges([
        `1 AD N... 100644 100644 000000 ${"a".repeat(40)} ${"b".repeat(40)} old.ts`,
        "? new file.ts",
        `2 R. N... 100644 100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} R100 new.ts`,
        "source.ts",
      ]),
    ).toEqual([
      { path: "new file.ts", untracked: true },
      { indexStatus: "R", originalPath: "source.ts", path: "new.ts" },
      { indexStatus: "A", path: "old.ts", worktreeStatus: "D" },
    ]);
  });
});
