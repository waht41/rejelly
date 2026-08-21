import type {
  BiomeChangedSelection,
  ProcessVerifyStep,
  ResolvedVerifyScope,
  VerifyChangeSummary,
  VerifyExecutionReport,
  VerifyExecutionStepResult,
  VerifyFailureReport,
  VerifyOptions,
  VerifyPlan,
  VerifyRunResult,
  VerifyStep,
} from "../contracts.js";
import { collectChangedPaths } from "../lib/changes.js";
import { type RunResult, run } from "../lib/process.js";
import {
  classifyRootImpact,
  downstreamPackageFilters,
  filterChangedPathsForPackages,
  loadWorkspacePackages,
  mapChangedPathsToPackages,
  resolveExactWorkspaceFilters,
  resolveTurboFilteredPackages,
} from "../lib/workspace.js";
import { existingBiomeCandidateFiles, runBiomeChanged } from "./biome-changed.js";

export function createVerifyPlan(
  options: VerifyOptions,
  scope: ResolvedVerifyScope,
  context: {
    biomeSelection?: BiomeChangedSelection;
    changedFileCount?: number;
    changeSummary?: VerifyChangeSummary;
    unmappedFiles?: string[];
  } = {},
): VerifyPlan {
  const steps: VerifyStep[] = [];
  if (options.biome === "all") {
    steps.push({
      command: "pnpm",
      args: ["exec", "biome", "check", ...(options.fix ? ["--write"] : []), "."],
      kind: "process",
      label: `Biome ${options.fix ? "write" : "check"} (all files)`,
    });
  } else if (options.biome === "changed") {
    steps.push({
      kind: "biome-changed",
      label: `Biome ${options.fix ? "write" : "check"} (changed files)`,
      ...(context.biomeSelection ? { selection: context.biomeSelection } : {}),
      write: options.fix,
    });
  }

  if (scope.kind !== "none") {
    const tasks = ["typecheck", "lint:jelly", "lint:doc", ...(options.tests ? ["test"] : [])];
    const turboArgs = ["exec", "turbo", "run", ...tasks, "--output-logs=errors-only"];
    if (scope.kind === "packages") {
      for (const filter of scope.filters) turboArgs.push(`--filter=${filter}`);
    }
    steps.push({ command: "pnpm", args: turboArgs, kind: "process", label: "workspace tasks" });
  }
  return {
    ...(context.changeSummary ? { changeSummary: context.changeSummary } : {}),
    ...(context.changedFileCount === undefined
      ? {}
      : { changedFileCount: context.changedFileCount }),
    scope,
    steps,
    ...(context.unmappedFiles ? { unmappedFiles: context.unmappedFiles } : {}),
  };
}

function changeSummary(input: {
  biomeFiles: readonly string[];
  directPackages: readonly string[];
  globalFiles: readonly string[];
  neutralRootFiles: readonly string[];
  totalFiles: readonly string[];
  workingTreeFiles: readonly string[];
}): VerifyChangeSummary {
  return {
    biomeFiles: input.biomeFiles.length,
    directPackages: [...input.directPackages],
    excludedFiles: input.totalFiles.length - input.biomeFiles.length,
    globalFiles: [...input.globalFiles],
    neutralRootFiles: [...input.neutralRootFiles],
    totalFiles: input.totalFiles.length,
    workingTreeFiles: input.workingTreeFiles.length,
  };
}

export function selectBiomeFiles(
  options: Pick<VerifyOptions, "fix" | "fixBranch">,
  branchFiles: readonly string[],
  workingTreeFiles: readonly string[],
): readonly string[] {
  return options.fix && !options.fixBranch ? workingTreeFiles : branchFiles;
}

export function assertFiltersMatched(
  filters: readonly string[],
  selectedPackages: readonly { name: string }[],
): void {
  if (selectedPackages.length === 0) {
    throw new Error(`No workspace package matched --filter ${filters.join(", ")}`);
  }
}

export function resolveAffectedScope(
  globalFiles: readonly string[],
  expandedPackages: readonly { name: string }[],
): ResolvedVerifyScope {
  if (globalFiles.length > 0) return { kind: "all" };
  if (expandedPackages.length > 0) {
    return {
      filters: expandedPackages.map((entry) => entry.name).sort(),
      kind: "packages",
      source: "affected",
    };
  }
  return { kind: "none", source: "affected" };
}

export function resolveVerifyPlan(repoRoot: string, options: VerifyOptions): VerifyPlan {
  if (options.scope.kind === "all") return createVerifyPlan(options, { kind: "all" });
  if (options.scope.kind === "filtered") {
    const workspacePackages = loadWorkspacePackages(repoRoot);
    const selectedPackages =
      resolveExactWorkspaceFilters(options.scope.filters, workspacePackages) ??
      resolveTurboFilteredPackages(repoRoot, options.scope.filters);
    assertFiltersMatched(options.scope.filters, selectedPackages);
    if (options.biome !== "changed") {
      return createVerifyPlan(options, {
        filters: options.scope.filters,
        kind: "packages",
        source: "explicit",
      });
    }
    const changed = collectChangedPaths(repoRoot, options.base);
    const affected = mapChangedPathsToPackages(repoRoot, changed.files, workspacePackages);
    const rootImpact = classifyRootImpact(affected.unmappedFiles);
    const branchBiomeFiles = filterChangedPathsForPackages(
      repoRoot,
      changed.files,
      workspacePackages,
      selectedPackages,
    );
    const workingTreeBiomeFiles = filterChangedPathsForPackages(
      repoRoot,
      changed.workingTreeFiles,
      workspacePackages,
      selectedPackages,
    );
    const biomeFiles = existingBiomeCandidateFiles(
      repoRoot,
      selectBiomeFiles(options, branchBiomeFiles, workingTreeBiomeFiles),
    );
    return createVerifyPlan(
      options,
      {
        filters: options.scope.filters,
        kind: "packages",
        source: "explicit",
      },
      {
        biomeSelection: {
          base: changed.base,
          files: biomeFiles,
        },
        changeSummary: changeSummary({
          biomeFiles,
          directPackages: selectedPackages.map((entry) => entry.name),
          globalFiles: rootImpact.globalFiles,
          neutralRootFiles: rootImpact.neutralFiles,
          totalFiles: changed.files,
          workingTreeFiles: changed.workingTreeFiles,
        }),
        changedFileCount: changed.files.length,
        unmappedFiles: affected.unmappedFiles,
      },
    );
  }

  const changed = collectChangedPaths(repoRoot, options.base);
  const affected = mapChangedPathsToPackages(
    repoRoot,
    changed.files,
    loadWorkspacePackages(repoRoot),
  );
  const rootImpact = classifyRootImpact(affected.unmappedFiles);
  const expandedPackages =
    affected.packages.length > 0
      ? resolveTurboFilteredPackages(repoRoot, downstreamPackageFilters(affected.packages))
      : [];
  const scope = resolveAffectedScope(rootImpact.globalFiles, expandedPackages);
  const biomeFiles = existingBiomeCandidateFiles(
    repoRoot,
    selectBiomeFiles(options, changed.files, changed.workingTreeFiles),
  );
  return createVerifyPlan(options, scope, {
    biomeSelection: { base: changed.base, files: biomeFiles },
    changeSummary: changeSummary({
      biomeFiles,
      directPackages: affected.packages,
      globalFiles: rootImpact.globalFiles,
      neutralRootFiles: rootImpact.neutralFiles,
      totalFiles: changed.files,
      workingTreeFiles: changed.workingTreeFiles,
    }),
    changedFileCount: changed.files.length,
    unmappedFiles: affected.unmappedFiles,
  });
}

function printableCommand(step: VerifyStep): string {
  return step.kind === "process"
    ? [step.command, ...step.args].join(" ")
    : `repo-tool biome-changed${step.write ? " --write" : ""}`;
}

function runProcessStep(
  repoRoot: string,
  step: ProcessVerifyStep,
  options: Pick<VerifyOptions, "timeoutMs">,
): Promise<RunResult> {
  return run(step.command, step.args, repoRoot, {
    output: "capture",
    timeoutMs: options.timeoutMs,
  });
}

function printScope(plan: VerifyPlan, verbose: boolean): void {
  if (plan.scope.kind === "all") {
    console.log("repo-tool verify: scope=all");
  } else if (plan.scope.kind === "none") {
    console.log(
      `repo-tool verify: scope=affected, packages=none, files=${plan.changedFileCount ?? 0}`,
    );
  } else {
    console.log(
      `repo-tool verify: scope=${plan.scope.source}, packages=${plan.scope.filters.join(", ")}`,
    );
  }
  const summary = plan.changeSummary;
  if (summary) {
    console.log(
      `repo-tool verify: changes total=${summary.totalFiles}, working-tree=${summary.workingTreeFiles}, ` +
        `biome=${summary.biomeFiles}, excluded=${summary.excludedFiles}`,
    );
    if (summary.directPackages.length > 0) {
      console.log(`repo-tool verify: direct packages=${summary.directPackages.join(", ")}`);
    }
    if (summary.globalFiles.length > 0) {
      const effect =
        plan.scope.kind === "all"
          ? "expanded scope to all"
          : plan.scope.kind === "packages" && plan.scope.source === "explicit"
            ? "explicit scope retained"
            : "";
      console.log(
        `repo-tool verify: global/root impact=${summary.globalFiles.length}${effect ? ` (${effect})` : ""}`,
      );
    }
    if (summary.neutralRootFiles.length > 0) {
      console.log(`repo-tool verify: neutral root files=${summary.neutralRootFiles.length}`);
    }
    if (verbose && plan.unmappedFiles) {
      for (const file of plan.unmappedFiles) console.log(`  ${file}`);
    }
  }
}

function stripAnsiControlSequences(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x1b || value[index + 1] !== "[") {
      result += value[index];
      continue;
    }
    index += 2;
    while (index < value.length) {
      const code = value.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) break;
      index += 1;
    }
  }
  return result;
}

export function compactProcessOutput(
  value: string,
  limits: { maxChars?: number; maxLines?: number } = {},
): { text: string; truncated: boolean } {
  const maxChars = limits.maxChars ?? 20_000;
  const maxLines = limits.maxLines ?? 100;
  const lines = value.trimEnd().split(/\r?\n/);
  const omittedLines = Math.max(0, lines.length - maxLines);
  let text = lines.slice(-maxLines).join("\n");
  let truncated = omittedLines > 0;
  if (text.length > maxChars) {
    text = text.slice(-maxChars);
    truncated = true;
  }
  if (truncated) {
    text = `[repo-tool] earlier child output omitted\n${text}`;
  }
  return { text, truncated };
}

export function extractFailureFacts(output: string): {
  failedTasks: string[];
  failedTestFiles: string[];
} {
  const plain = stripAnsiControlSequences(output);
  const failedTasks = [
    ...new Set(
      [...plain.matchAll(/\bFailed:\s+([^\r\n]+)/g)]
        .map((match) => match[1]?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const failedTestFiles = [
    ...new Set(
      [...plain.matchAll(/\bFAIL\s+([^\s]+\.(?:test|spec)\.[cm]?[jt]sx?)/g)]
        .map((match) => match[1]?.replaceAll("\\", "/"))
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  return { failedTasks, failedTestFiles };
}

function executionStatus(
  result: Pick<RunResult, "cancelled" | "status" | "timedOut">,
): VerifyExecutionReport["status"] {
  if (result.cancelled) return "cancelled";
  if (result.timedOut) return "timed_out";
  return result.status === 0 ? "passed" : "failed";
}

function failureReport(step: VerifyStep, output: string): VerifyFailureReport {
  const diagnostics = compactProcessOutput(stripAnsiControlSequences(output));
  return {
    ...extractFailureFacts(output),
    diagnostics: diagnostics.text,
    diagnosticsTruncated: diagnostics.truncated,
    step: step.label,
  };
}

function printChildOutput(output: string, failed: boolean): void {
  const compact = compactProcessOutput(output, {
    maxChars: failed ? 20_000 : 8_000,
    maxLines: failed ? 100 : 30,
  });
  if (compact.text) console.log(compact.text);
}

function reportFor(
  plan: VerifyPlan,
  steps: readonly VerifyExecutionStepResult[],
  exitCode: number,
  status: VerifyExecutionReport["status"],
  failure?: VerifyFailureReport,
): VerifyExecutionReport {
  return {
    ...(plan.changeSummary ? { changeSummary: plan.changeSummary } : {}),
    exitCode,
    ...(failure ? { failure } : {}),
    plan,
    schemaVersion: 1,
    scope: plan.scope,
    status,
    steps: [...steps],
  };
}

export async function runVerify(
  repoRoot: string,
  options: VerifyOptions,
): Promise<VerifyRunResult> {
  const plan = resolveVerifyPlan(repoRoot, options);
  if (!options.json) {
    printScope(plan, options.verbose);
    console.log(`repo-tool verify: ${plan.steps.length} step(s)`);
    for (const [index, step] of plan.steps.entries()) {
      console.log(`  ${index + 1}. ${step.label}: ${printableCommand(step)}`);
    }
  }
  if (options.dryRun) {
    const report = reportFor(plan, [], 0, "passed");
    if (options.json) console.log(JSON.stringify(report, null, 2));
    return { exitCode: 0, report };
  }

  const stepResults: VerifyExecutionStepResult[] = [];
  for (const step of plan.steps) {
    if (!options.json) console.log(`\n[repo-tool] ${step.label}`);
    const startedAt = Date.now();
    let processResult: RunResult;
    if (step.kind === "biome-changed") {
      const result = await runBiomeChanged(repoRoot, {
        allowMany: options.allowMany,
        base: options.base,
        maxFiles: options.maxFiles,
        output: options.json ? "capture" : "inherit",
        quiet: options.json,
        ...(step.selection ? { selection: step.selection } : {}),
        timeoutMs: options.timeoutMs,
        verbose: options.verbose,
        write: step.write,
      });
      processResult = {
        cancelled: result.failures.some((failure) => failure.result.cancelled),
        output: result.failures.map((failure) => failure.result.output).join("\n"),
        status: result.status,
        stderr: result.failures.map((failure) => failure.result.stderr).join("\n"),
        stdout: result.failures.map((failure) => failure.result.stdout).join("\n"),
        timedOut: result.failures.some((failure) => failure.result.timedOut),
      };
    } else {
      processResult = await runProcessStep(repoRoot, step, options);
    }
    stepResults.push({
      cancelled: processResult.cancelled,
      durationMs: Date.now() - startedAt,
      exitCode: processResult.status,
      label: step.label,
      timedOut: processResult.timedOut,
    });
    if (step.kind === "process" && !options.json) {
      printChildOutput(processResult.output, processResult.status !== 0);
    }
    if (processResult.status !== 0) {
      const status = executionStatus(processResult);
      const failure = failureReport(step, processResult.output);
      const report = reportFor(plan, stepResults, processResult.status, status, failure);
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.error(`[repo-tool] failed: ${step.label} (exit ${processResult.status})`);
      }
      return { exitCode: processResult.status, report };
    }
  }
  const report = reportFor(plan, stepResults, 0, "passed");
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log("\nrepo-tool verify: ok");
  return { exitCode: 0, report };
}
