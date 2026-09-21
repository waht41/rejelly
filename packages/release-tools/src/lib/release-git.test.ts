import { describe, expect, it, vi } from "vitest";
import { checkReleaseGitState } from "./release-git.js";

const head = "1111111111111111111111111111111111111111";

function gitFixture(overrides: Record<string, string | Error> = {}) {
  const values: Record<string, string | Error> = {
    "fetch --quiet origin main": "",
    "rev-parse --abbrev-ref --symbolic-full-name @{upstream}": "origin/main",
    "rev-parse HEAD": head,
    "rev-parse origin/main": head,
    "status --porcelain": "",
    "symbolic-ref --short --quiet HEAD": "main",
    ...overrides,
  };

  return vi.fn((args: string[]) => {
    const key = args.join(" ");
    const value = values[key];
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error(`Unexpected git command: ${key}`);
    return value;
  });
}

describe("checkReleaseGitState", () => {
  it("refreshes origin/main and accepts a clean synchronized main branch", () => {
    const runGit = gitFixture();

    expect(checkReleaseGitState("repo", {}, runGit)).toMatchObject({
      branch: "main",
      dirty: false,
      head,
      issues: [],
      remoteHead: head,
      upstream: "origin/main",
    });
    expect(runGit).toHaveBeenCalledWith(["fetch", "--quiet", "origin", "main"]);
  });

  it("fails local identity checks before fetching", () => {
    const runGit = gitFixture({
      "rev-parse --abbrev-ref --symbolic-full-name @{upstream}": "origin/feature",
      "status --porcelain": " M package.json",
      "symbolic-ref --short --quiet HEAD": "feature/release",
    });

    expect(checkReleaseGitState("repo", {}, runGit).issues).toEqual([
      { actual: "feature/release", expected: "main", label: "branch" },
      { actual: "origin/feature", expected: "origin/main", label: "upstream" },
      { actual: "dirty", expected: "clean", label: "working-tree" },
    ]);
    expect(runGit).not.toHaveBeenCalledWith(["fetch", "--quiet", "origin", "main"]);
  });

  it("rejects a detached HEAD without an upstream", () => {
    const runGit = gitFixture({
      "rev-parse --abbrev-ref --symbolic-full-name @{upstream}": new Error("no upstream"),
      "symbolic-ref --short --quiet HEAD": new Error("detached"),
    });

    expect(checkReleaseGitState("repo", {}, runGit).issues).toEqual([
      { actual: "(detached)", expected: "main", label: "branch" },
      { actual: "(none)", expected: "origin/main", label: "upstream" },
    ]);
  });

  it("rejects a local main commit that differs from refreshed origin/main", () => {
    const remoteHead = "2222222222222222222222222222222222222222";
    const runGit = gitFixture({ "rev-parse origin/main": remoteHead });

    expect(checkReleaseGitState("repo", {}, runGit).issues).toEqual([
      { actual: head, expected: remoteHead, label: "head" },
    ]);
  });
});
