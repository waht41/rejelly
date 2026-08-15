import type {
  ProcessVerifyStep,
  ResolvedVerifyScope,
  VerifyOptions,
  VerifyPlan,
  VerifyStep,
} from "../contracts.js";
import { collectChangedPaths } from "../lib/changes.js";
import { run } from "../lib/process.js";
import { loadWorkspacePackages, mapChangedPathsToPackages } from "../lib/workspace.js";
import { runBiomeChanged } from "./biome-changed.js";

export function createVerifyPlan(
  options: VerifyOptions,
  scope: ResolvedVerifyScope,
  context: { changedFileCount?: number; unmappedFiles?: string[] } = {},
): VerifyPlan {
  const steps: VerifyStep[] = [];
  if (scope.kind !== "none") {
    const tasks = ["typecheck", "lint:jelly", "lint:doc", ...(options.tests ? ["test"] : [])];
    const turboArgs = ["exec", "turbo", "run", ...tasks, "--output-logs=errors-only"];
    if (scope.kind === "packages") {
      for (const filter of scope.filters) turboArgs.push(`--filter=${filter}`);
    }
    steps.push({ command: "pnpm", args: turboArgs, kind: "process", label: "workspace tasks" });
  }

  if (options.biome === "all") {
    steps.push({
      command: "pnpm",
      args: ["exec", "biome", "check", "."],
      kind: "process",
      label: "Biome (all files)",
    });
  } else if (options.biome === "changed") {
    steps.push({ kind: "biome-changed", label: "Biome (changed files)" });
  }
  return { ...context, scope, steps };
}

export function resolveVerifyPlan(repoRoot: string, options: VerifyOptions): VerifyPlan {
  if (options.scope.kind === "all") return createVerifyPlan(options, { kind: "all" });
  if (options.scope.kind === "filtered") {
    return createVerifyPlan(options, {
      filters: options.scope.filters,
      kind: "packages",
      source: "explicit",
    });
  }

  const changed = collectChangedPaths(repoRoot, options.base);
  const affected = mapChangedPathsToPackages(
    repoRoot,
    changed.files,
    loadWorkspacePackages(repoRoot),
  );
  const scope: ResolvedVerifyScope =
    affected.packages.length > 0
      ? { filters: affected.packages, kind: "packages", source: "affected" }
      : { kind: "none", source: "affected" };
  return createVerifyPlan(options, scope, {
    changedFileCount: changed.files.length,
    unmappedFiles: affected.unmappedFiles,
  });
}

function printableCommand(step: VerifyStep): string {
  return step.kind === "process"
    ? [step.command, ...step.args].join(" ")
    : "repo-tool biome-changed";
}

function runProcessStep(repoRoot: string, step: ProcessVerifyStep): number {
  return run(step.command, step.args, repoRoot);
}

function printScope(plan: VerifyPlan): void {
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
  if (plan.unmappedFiles && plan.unmappedFiles.length > 0) {
    console.log(`repo-tool verify: ${plan.unmappedFiles.length} root/unmapped changed file(s)`);
    for (const file of plan.unmappedFiles) console.log(`  ${file}`);
  }
}

export function runVerify(repoRoot: string, options: VerifyOptions): number {
  const plan = resolveVerifyPlan(repoRoot, options);
  printScope(plan);
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
            write: false,
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
