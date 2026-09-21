#!/usr/bin/env node
import { cac } from "cac";
import { findRepoRoot, isEntrypoint } from "../lib/paths.js";
import { checkReleaseGitState } from "../lib/release-git.js";

export function main(argv = process.argv.slice(2)) {
  const cli = cac("release-check-git");

  cli
    .option("--branch <branch>", "Required release branch.", { default: "main" })
    .option("--remote <remote>", "Required release remote.", { default: "origin" })
    .help();

  const parsed = cli.parse(["node", "release-check-git", ...argv], { run: false });

  if (parsed.options.help) {
    return;
  }

  const report = checkReleaseGitState(findRepoRoot(), {
    branch: parsed.options.branch,
    remote: parsed.options.remote,
  });

  console.log(
    `release-check-git: branch=${report.branch} upstream=${report.upstream} dirty=${report.dirty ? "yes" : "no"}`,
  );

  if (report.remoteHead) {
    console.log(
      `release-check-git: head=${shortSha(report.head)} ${report.expectedUpstream}=${shortSha(report.remoteHead)}`,
    );
  }

  if (report.issues.length === 0) {
    console.log("release-check-git: ok");
    return;
  }

  console.error("release-check-git: refusing to publish:");
  for (const issue of report.issues) {
    console.error(`  - ${issue.label}: expected ${issue.expected}, actual ${issue.actual}`);
  }
  process.exitCode = 1;
}

function shortSha(value: string) {
  return value.slice(0, 12);
}

if (isEntrypoint(import.meta.url)) {
  main();
}
