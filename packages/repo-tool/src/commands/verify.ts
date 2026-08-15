import type { ProcessVerifyStep, VerifyOptions, VerifyStep } from "../contracts.js";
import { run } from "../lib/process.js";
import { runBiomeChanged } from "./biome-changed.js";

export function createVerifyPlan(options: VerifyOptions): VerifyStep[] {
  const tasks = ["typecheck", "lint:jelly", "lint:doc", ...(options.tests ? ["test"] : [])];
  const turboArgs = ["exec", "turbo", "run", ...tasks];
  if (options.scope.kind === "affected") turboArgs.push("--affected");
  if (options.scope.kind === "filtered") {
    for (const filter of options.scope.filters) turboArgs.push(`--filter=${filter}`);
  }

  const steps: VerifyStep[] = [
    { command: "pnpm", args: turboArgs, kind: "process", label: "workspace tasks" },
  ];
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
  return steps;
}

function printableCommand(step: VerifyStep): string {
  return step.kind === "process"
    ? [step.command, ...step.args].join(" ")
    : "repo-tool biome-changed";
}

function runProcessStep(repoRoot: string, step: ProcessVerifyStep): number {
  return run(step.command, step.args, repoRoot);
}

export function runVerify(repoRoot: string, options: VerifyOptions): number {
  const plan = createVerifyPlan(options);
  console.log(`repo-tool verify: ${plan.length} step(s)`);
  for (const [index, step] of plan.entries()) {
    console.log(`  ${index + 1}. ${step.label}: ${printableCommand(step)}`);
  }
  if (options.dryRun) return 0;

  for (const step of plan) {
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
