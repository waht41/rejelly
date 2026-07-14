import { exec } from "./exec.js";
import type { PublishablePackage } from "./workspace.js";

export function affectedPackagesFromTurbo(
  repoRoot: string,
  base: string | undefined,
  packages: PublishablePackage[],
  task = "build",
): Set<string> | undefined {
  if (!base) {
    return undefined;
  }

  try {
    const output = exec(
      "pnpm",
      ["exec", "turbo", "run", task, `--filter=...[${base}]`, "--dry=json"],
      {
        cwd: repoRoot,
        ignoreErrors: true,
      },
    );
    const parsed = JSON.parse(output);
    const packageNames = extractTurboPackages(parsed);
    const publishableNames = new Set(packages.map((pkg) => pkg.name));

    return new Set([...packageNames].filter((packageName) => publishableNames.has(packageName)));
  } catch {
    return undefined;
  }
}

function extractTurboPackages(value: unknown) {
  const result = new Set<string>();
  collectPackageNames(value, result);
  return result;
}

function collectPackageNames(value: unknown, result: Set<string>) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPackageNames(item, result);
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;

  for (const key of ["package", "packageName"]) {
    const packageName = record[key];

    if (typeof packageName === "string") {
      result.add(packageName);
    }
  }

  if (typeof record.taskId === "string" && record.taskId.includes("#")) {
    result.add(record.taskId.split("#")[0]);
  }

  for (const child of Object.values(record)) {
    collectPackageNames(child, result);
  }
}
