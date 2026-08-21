import type {
  BranchCommit,
  BranchDiffStat,
  BranchReport,
  BranchStatusCode,
  BranchWorkingTreeChange,
} from "../contracts.js";
import { createGit, type Git, resolveBase } from "../lib/git.js";

function naturalNumber(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function statusCode(value: string | undefined): BranchStatusCode | undefined {
  return value && value !== "." ? (value as BranchStatusCode) : undefined;
}

function splitPrefix(record: string, fieldCount: number): { fields: string[]; remainder: string } {
  const fields: string[] = [];
  let cursor = 0;
  for (let index = 0; index < fieldCount; index += 1) {
    const separator = record.indexOf(" ", cursor);
    if (separator < 0) return { fields, remainder: "" };
    fields.push(record.slice(cursor, separator));
    cursor = separator + 1;
  }
  return { fields, remainder: record.slice(cursor) };
}

/** Parse `git status --porcelain=v2 -z` into one canonical working-tree projection. */
export function parseWorkingTreeChanges(records: readonly string[]): BranchWorkingTreeChange[] {
  const changes: BranchWorkingTreeChange[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.startsWith("? ")) {
      changes.push({ path: record.slice(2), untracked: true });
      continue;
    }
    const type = record.slice(0, 1);
    const fieldCount = type === "1" ? 7 : type === "2" ? 8 : type === "u" ? 9 : 0;
    if (fieldCount === 0 || record.slice(1, 2) !== " ") continue;
    const { fields, remainder: path } = splitPrefix(record.slice(2), fieldCount);
    const xy = fields[0] ?? "..";
    const originalPath = type === "2" ? records[++index] : undefined;
    changes.push({
      ...(statusCode(xy[0]) ? { indexStatus: statusCode(xy[0]) } : {}),
      ...(originalPath ? { originalPath } : {}),
      path,
      ...(statusCode(xy[1]) ? { worktreeStatus: statusCode(xy[1]) } : {}),
    });
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

export function collectBranchReport(
  git: Git,
  requestedBase?: string,
  maxCommits = 20,
): BranchReport {
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
  const commitCandidates = parseCommits(
    git.text(["log", `--max-count=${maxCommits + 1}`, "--format=%h%x09%s", `${mergeBase}..HEAD`]),
  );

  return {
    ahead: naturalNumber(aheadRaw),
    base,
    behind: naturalNumber(behindRaw),
    branch,
    commits: commitCandidates.slice(0, maxCommits),
    commitsTruncated: commitCandidates.length > maxCommits,
    diff: parseDiffStat(git.text(["diff", "--numstat", mergeBase])),
    head,
    mergeBase,
    schemaVersion: 2,
    ...(upstream ? { upstream } : {}),
    workingTree: parseWorkingTreeChanges(
      git.nul(["status", "--porcelain=v2", "--untracked-files=all"]),
    ),
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
  const staged = report.workingTree.filter((change) => change.indexStatus).length;
  const unstaged = report.workingTree.filter((change) => change.worktreeStatus).length;
  const untracked = report.workingTree.filter((change) => change.untracked).length;
  const lines = [
    `branch: ${report.branch} (${report.head})`,
    `base: ${report.base} (${report.mergeBase.slice(0, 12)})`,
    `tracking: ahead ${report.ahead}, behind ${report.behind}${report.upstream ? `, upstream ${report.upstream}` : ""}`,
    `diff: ${report.diff.files} files, +${report.diff.insertions}/-${report.diff.deletions}, ${report.diff.binary} binary`,
    `changes: staged ${staged}, unstaged ${unstaged}, untracked ${untracked}`,
  ];
  if (report.commits.length > 0) {
    lines.push(`commits (${report.commits.length})`);
    for (const commit of report.commits) lines.push(`  ${commit.shortSha} ${commit.subject}`);
    if (report.commitsTruncated) lines.push("  … additional commits omitted");
  }
  if (report.workingTree.length > 0) {
    lines.push(`working tree (${report.workingTree.length})`);
    for (const change of report.workingTree) {
      const status = change.untracked
        ? "??"
        : `${change.indexStatus ?? "."}${change.worktreeStatus ?? "."}`;
      lines.push(
        `  ${status} ${change.path}${change.originalPath ? ` <- ${change.originalPath}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

export function runBranchReport(
  repoRoot: string,
  options: { base?: string; json: boolean; maxCommits: number },
): void {
  const report = collectBranchReport(createGit(repoRoot), options.base, options.maxCommits);
  console.log(options.json ? JSON.stringify(report, null, 2) : formatBranchReport(report));
}
