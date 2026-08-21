import type {
  BiomeChangedSelection,
  ProcessVerifyStep,
  ResolvedVerifyScope,
  VerifyChangeSummary,
  VerifyOptions,
  VerifyPlan,
  VerifyStep,
} from "../contracts.js";
import { collectChangedPaths } from "../lib/changes.js";
import { run } from "../lib/process.js";
import {
  classifyRootImpact,
  downstreamPackageFilters,
  filterChangedPathsForPackages,
  loadWorkspacePackages,
  mapChangedPathsToPackages,
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
    const selectedPackages = resolveTurboFilteredPackages(repoRoot, options.scope.filters);
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

function runProcessStep(repoRoot: string, step: ProcessVerifyStep): number {
  return run(step.command, step.args, repoRoot);
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

export function runVerify(repoRoot: string, options: VerifyOptions): number {
  const plan = resolveVerifyPlan(repoRoot, options);
  printScope(plan, options.verbose);
  console.log(`repo-tool verify: ${plan.steps.length} step(s)`);
  for (const [index, step] of plan.steps.entries()) {
    console.log(`  ${index + 1}. ${step.label}: ${printableCommand(step)}`);
  }
  if (options.dryRun) return 0;

  for (const step of plan.steps) {
    console.log(`\n[repo-tool] ${step.label}`);
    const status =
      step.kind === "biome-changed"
        ? runBiomeChanged(repoRoot, {
            allowMany: options.allowMany,
            base: options.base,
            maxFiles: options.maxFiles,
            ...(step.selection ? { selection: step.selection } : {}),
            verbose: options.verbose,
            write: step.write,
          })
        : runProcessStep(repoRoot, step);
    if (status !== 0) {
      console.error(`[repo-tool] failed: ${step.label} (exit ${status})`);
      return status;
    }
  }
  console.log("\nrepo-tool verify: ok");
  return 0;
}
