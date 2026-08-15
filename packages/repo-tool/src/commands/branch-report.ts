import type { BranchCommit, BranchDiffStat, BranchReport } from "../contracts.js";
import { createGit, type Git, resolveBase } from "../lib/git.js";

const DIFF_FILTER = "ACDMRTUXB";

function naturalNumber(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function collectBranchReport(git: Git, requestedBase?: string): BranchReport {
  const base = resolveBase(git, requestedBase);
  const branch = git.text(["symbolic-ref", "--short", "--quiet", "HEAD"], true) || "(detached)";
  const head = git.text(["rev-parse", "--short=12", "HEAD"]);
  const upstream = git.text(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    true,
  );
  const mergeBase = git.text(["merge-base", "HEAD", base]);
  const [behindRaw, aheadRaw] = git
    .text(["rev-list", "--left-right", "--count", `${base}...HEAD`])
    .split(/\s+/)
    .filter(Boolean);
  const commits = parseCommits(git.text(["log", "--format=%h%x09%s", `${mergeBase}..HEAD`]));

  return {
    ahead: naturalNumber(aheadRaw),
    base,
    behind: naturalNumber(behindRaw),
    branch,
    commits,
    diff: parseDiffStat(git.text(["diff", "--numstat", mergeBase])),
    head,
    mergeBase,
    staged: git.nul(["diff", "--cached", "--name-only", `--diff-filter=${DIFF_FILTER}`]),
    unstaged: git.nul(["diff", "--name-only", `--diff-filter=${DIFF_FILTER}`]),
    untracked: git.nul(["ls-files", "--others", "--exclude-standard"]),
    ...(upstream ? { upstream } : {}),
  };
}

export function parseCommits(output: string): BranchCommit[] {
  if (!output) return [];
  return output.split(/\r?\n/).map((line) => {
    const separator = line.indexOf("\t");
    return separator < 0
      ? { shortSha: line, subject: "" }
      : { shortSha: line.slice(0, separator), subject: line.slice(separator + 1) };
  });
}

export function parseDiffStat(output: string): BranchDiffStat {
  const result: BranchDiffStat = { binary: 0, deletions: 0, files: 0, insertions: 0 };
  if (!output) return result;
  for (const line of output.split(/\r?\n/)) {
    const [insertions, deletions] = line.split("\t", 3);
    result.files += 1;
    if (insertions === "-" || deletions === "-") {
      result.binary += 1;
    } else {
      result.insertions += naturalNumber(insertions);
      result.deletions += naturalNumber(deletions);
    }
  }
  return result;
}

export function formatBranchReport(report: BranchReport): string {
  const lines = [
    `branch: ${report.branch} (${report.head})`,
    `base: ${report.base} (${report.mergeBase.slice(0, 12)})`,
    `tracking: ahead ${report.ahead}, behind ${report.behind}${report.upstream ? `, upstream ${report.upstream}` : ""}`,
    `diff: ${report.diff.files} files, +${report.diff.insertions}/-${report.diff.deletions}, ${report.diff.binary} binary`,
    `changes: staged ${report.staged.length}, unstaged ${report.unstaged.length}, untracked ${report.untracked.length}`,
  ];
  if (report.commits.length > 0) {
    lines.push(`commits (${report.commits.length})`);
    for (const commit of report.commits) lines.push(`  ${commit.shortSha} ${commit.subject}`);
  }
  for (const [label, files] of [
    ["staged", report.staged],
    ["unstaged", report.unstaged],
    ["untracked", report.untracked],
  ] as const) {
    if (files.length === 0) continue;
    lines.push(`${label} (${files.length})`, ...files.map((file) => `  ${file}`));
  }
  return lines.join("\n");
}

export function runBranchReport(repoRoot: string, options: { base?: string; json: boolean }): void {
  const report = collectBranchReport(createGit(repoRoot), options.base);
  console.log(options.json ? JSON.stringify(report, null, 2) : formatBranchReport(report));
}
