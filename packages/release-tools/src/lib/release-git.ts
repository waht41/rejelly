import { git } from "./git.js";

export type ReleaseGitOptions = {
  branch?: string;
  remote?: string;
};

export type ReleaseGitIssue = {
  actual: string;
  expected: string;
  label: "branch" | "head" | "upstream" | "working-tree";
};

export type ReleaseGitReport = {
  branch: string;
  dirty: boolean;
  expectedBranch: string;
  expectedUpstream: string;
  head: string;
  issues: ReleaseGitIssue[];
  remoteHead?: string;
  upstream: string;
};

type RunGit = (args: string[]) => string;

/**
 * Guard a public release at the capability boundary that owns publishing.
 * Local identity checks run before the network fetch so obvious mistakes fail quickly;
 * a valid release candidate then refreshes the remote branch before comparing commits.
 */
export function checkReleaseGitState(
  repoRoot: string,
  options: ReleaseGitOptions = {},
  runGit: RunGit = (args) => git(repoRoot, args),
): ReleaseGitReport {
  const expectedBranch = options.branch ?? "main";
  const remote = options.remote ?? "origin";
  const expectedUpstream = `${remote}/${expectedBranch}`;
  const branch =
    optionalGit(runGit, ["symbolic-ref", "--short", "--quiet", "HEAD"]) || "(detached)";
  const upstream =
    optionalGit(runGit, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]) ||
    "(none)";
  const head = runGit(["rev-parse", "HEAD"]);
  const dirty = runGit(["status", "--porcelain"]).length > 0;
  const issues: ReleaseGitIssue[] = [];

  if (branch !== expectedBranch) {
    issues.push({ actual: branch, expected: expectedBranch, label: "branch" });
  }
  if (upstream !== expectedUpstream) {
    issues.push({ actual: upstream, expected: expectedUpstream, label: "upstream" });
  }
  if (dirty) {
    issues.push({ actual: "dirty", expected: "clean", label: "working-tree" });
  }

  if (issues.length > 0) {
    return {
      branch,
      dirty,
      expectedBranch,
      expectedUpstream,
      head,
      issues,
      upstream,
    };
  }

  runGit(["fetch", "--quiet", remote, expectedBranch]);
  const remoteHead = runGit(["rev-parse", expectedUpstream]);

  if (head !== remoteHead) {
    issues.push({ actual: head, expected: remoteHead, label: "head" });
  }

  return {
    branch,
    dirty,
    expectedBranch,
    expectedUpstream,
    head,
    issues,
    remoteHead,
    upstream,
  };
}

function optionalGit(runGit: RunGit, args: string[]) {
  try {
    return runGit(args);
  } catch {
    return "";
  }
}
