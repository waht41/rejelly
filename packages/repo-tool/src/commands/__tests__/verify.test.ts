import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { VerifyOptions } from "../../contracts.js";
import {
  assertFiltersMatched,
  compactProcessOutput,
  createVerifyPlan,
  extractFailureFacts,
  formatFailureDiagnostics,
  formatRelatedTestFallback,
  isSafeRelatedTestPath,
  isTestNeutralPackagePath,
  resolveAffectedScope,
  resolveRelatedTestPlan,
  selectBiomeFiles,
} from "../verify.js";

const defaults: VerifyOptions = {
  allowMany: false,
  biome: "changed",
  dryRun: false,
  fix: false,
  fixBranch: false,
  json: false,
  maxFiles: 100,
  relatedTests: false,
  scope: { kind: "affected" },
  tests: true,
  verbose: false,
};

describe("createVerifyPlan", () => {
  const guidanceCheckStep = {
    command: "pnpm",
    args: ["--filter", "create-rejelly", "run", "lint:doc"],
    kind: "process" as const,
    label: "create/docs guidance consistency",
  };

  it("turns affected packages into explicit Turbo filters", () => {
    expect(
      createVerifyPlan(defaults, {
        filters: ["@rejelly/repo-tool"],
        kind: "packages",
        source: "affected",
      }),
    ).toEqual({
      scope: {
        filters: ["@rejelly/repo-tool"],
        kind: "packages",
        source: "affected",
      },
      steps: [
        {
          kind: "biome-changed",
          label: "Biome check (changed files)",
          write: false,
        },
        guidanceCheckStep,
        {
          command: "pnpm",
          args: [
            "exec",
            "turbo",
            "run",
            "typecheck",
            "lint:jelly",
            "lint:doc",
            "test",
            "--output-logs=errors-only",
            "--filter=@rejelly/repo-tool",
          ],
          kind: "process",
          label: "workspace tasks",
        },
      ],
    });
  });

  it("supports explicit filtered checks without tests or Biome", () => {
    const plan = createVerifyPlan(
      { ...defaults, biome: "skip", tests: false },
      {
        filters: ["@rejelly/evil-jelly"],
        kind: "packages",
        source: "explicit",
      },
    );
    expect(plan.steps).toEqual([
      guidanceCheckStep,
      {
        command: "pnpm",
        args: [
          "exec",
          "turbo",
          "run",
          "typecheck",
          "lint:jelly",
          "lint:doc",
          "--output-logs=errors-only",
          "--filter=@rejelly/evil-jelly",
        ],
        kind: "process",
        label: "workspace tasks",
      },
    ]);
  });

  it("separates related direct-package tests from safe full-test fallbacks", () => {
    const plan = createVerifyPlan(
      { ...defaults, relatedTests: true },
      {
        filters: ["@rejelly/app", "@rejelly/downstream"],
        kind: "packages",
        source: "affected",
      },
      {
        relatedTestPlan: {
          fallbacks: [
            {
              packageName: "@rejelly/downstream",
              reasons: [
                {
                  code: "not-directly-changed",
                  message:
                    "package is not directly changed, so Vitest related has no local input files",
                },
              ],
            },
          ],
          fullPackageFilters: ["@rejelly/downstream"],
          relatedPackages: [{ files: ["src/feature.ts"], packageName: "@rejelly/app" }],
        },
      },
    );

    expect(plan.relatedTestFallbacks).toEqual([
      {
        packageName: "@rejelly/downstream",
        reasons: [
          {
            code: "not-directly-changed",
            message: "package is not directly changed, so Vitest related has no local input files",
          },
        ],
      },
    ]);
    expect(plan.steps).toEqual([
      { kind: "biome-changed", label: "Biome check (changed files)", write: false },
      guidanceCheckStep,
      {
        command: "pnpm",
        args: [
          "exec",
          "turbo",
          "run",
          "typecheck",
          "lint:jelly",
          "lint:doc",
          "--output-logs=errors-only",
          "--filter=@rejelly/app",
          "--filter=@rejelly/downstream",
        ],
        kind: "process",
        label: "workspace tasks",
      },
      {
        command: "pnpm",
        args: [
          "exec",
          "turbo",
          "run",
          "test",
          "--output-logs=errors-only",
          "--filter=@rejelly/downstream",
        ],
        kind: "process",
        label: "full tests (safe fallback)",
      },
      {
        command: "pnpm",
        args: [
          "--filter",
          "@rejelly/app",
          "exec",
          "vitest",
          "related",
          "src/feature.ts",
          "--run",
          "--passWithNoTests",
        ],
        kind: "process",
        label: "related tests (@rejelly/app)",
      },
    ]);
  });

  it("runs the whole workspace and full Biome only when requested", () => {
    const plan = createVerifyPlan(
      { ...defaults, biome: "all", scope: { kind: "all" } },
      { kind: "all" },
    );
    expect(plan.steps).toEqual([
      {
        command: "pnpm",
        args: ["exec", "biome", "check", "."],
        kind: "process",
        label: "Biome check (all files)",
      },
      guidanceCheckStep,
      {
        command: "pnpm",
        args: [
          "exec",
          "turbo",
          "run",
          "typecheck",
          "lint:jelly",
          "lint:doc",
          "test",
          "--output-logs=errors-only",
        ],
        kind: "process",
        label: "workspace tasks",
      },
    ]);
  });

  it("writes with Biome and synchronizes create guidance before workspace tasks with --fix", () => {
    const plan = createVerifyPlan(
      { ...defaults, fix: true },
      { filters: ["@rejelly/repo-tool"], kind: "packages", source: "explicit" },
    );

    expect(plan.steps[0]).toEqual({
      kind: "biome-changed",
      label: "Biome write (changed files)",
      write: true,
    });
    expect(plan.steps[1]).toEqual({
      command: "pnpm",
      args: ["--filter", "create-rejelly", "run", "generate:guidance"],
      kind: "process",
      label: "create/docs guidance sync",
    });
    expect(plan.steps[2]?.label).toBe("workspace tasks");
  });

  it("still checks create/docs consistency when no changed file belongs to a package", () => {
    const plan = createVerifyPlan(defaults, { kind: "none", source: "affected" });
    expect(plan.steps).toEqual([
      { kind: "biome-changed", label: "Biome check (changed files)", write: false },
      guidanceCheckStep,
    ]);
  });
});

describe("verify scope guards", () => {
  it("rejects filters that resolve to no workspace package", () => {
    expect(() => assertFiltersMatched(["@rejelly/missing"], [])).toThrow(
      "No workspace package matched --filter @rejelly/missing",
    );
  });

  it("promotes global root changes to all packages and leaves neutral-only roots taskless", () => {
    expect(resolveAffectedScope(["pnpm-lock.yaml"], [])).toEqual({ kind: "all" });
    expect(resolveAffectedScope([], [])).toEqual({ kind: "none", source: "affected" });
  });

  it("keeps fixing on dirty files unless --branch is explicit", () => {
    expect(
      selectBiomeFiles({ fix: true, fixBranch: false }, ["old.ts", "new.ts"], ["new.ts"]),
    ).toEqual(["new.ts"]);
    expect(
      selectBiomeFiles({ fix: true, fixBranch: true }, ["old.ts", "new.ts"], ["new.ts"]),
    ).toEqual(["old.ts", "new.ts"]);
  });
});

describe("related test selection", () => {
  it("accepts ordinary source and test files but rejects entrypoints and implicit fixtures", () => {
    expect(isSafeRelatedTestPath("src/feature.ts")).toBe(true);
    expect(isSafeRelatedTestPath("src/feature.test.ts")).toBe(true);
    expect(isSafeRelatedTestPath("src/cli/index.ts")).toBe(false);
    expect(isSafeRelatedTestPath("src/domain/__tests__/fixtures/child.ts")).toBe(false);
    expect(isSafeRelatedTestPath("vitest.config.ts")).toBe(false);
  });

  it("treats package documentation as test-neutral", () => {
    expect(isTestNeutralPackagePath("README.md")).toBe(true);
    expect(isTestNeutralPackagePath("CHANGELOG.md")).toBe(true);
    expect(isTestNeutralPackagePath("docs/usage.md")).toBe(true);
    expect(isTestNeutralPackagePath("src/usage.md")).toBe(false);
    expect(isTestNeutralPackagePath("package.json")).toBe(false);
  });

  it("uses related tests only for directly changed Vitest packages", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "repo-tool-related-"));
    try {
      const appPath = path.join(repoRoot, "packages", "app");
      const downstreamPath = path.join(repoRoot, "packages", "downstream");
      fs.mkdirSync(path.join(appPath, "src"), { recursive: true });
      fs.mkdirSync(path.join(downstreamPath, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(appPath, "package.json"),
        JSON.stringify({ name: "@repo/app", scripts: { test: "vitest run" } }),
      );
      fs.writeFileSync(
        path.join(downstreamPath, "package.json"),
        JSON.stringify({ name: "@repo/downstream", scripts: { test: "vitest run" } }),
      );
      fs.writeFileSync(path.join(appPath, "src", "feature.ts"), "export {};\n");

      expect(
        resolveRelatedTestPlan({
          changedFiles: ["packages/app/src/feature.ts"],
          directPackageNames: ["@repo/app"],
          repoRoot,
          selectedPackages: [
            { name: "@repo/app", path: appPath },
            { name: "@repo/downstream", path: downstreamPath },
          ],
        }),
      ).toEqual({
        fallbacks: [
          {
            packageName: "@repo/downstream",
            reasons: [
              {
                code: "not-directly-changed",
                message:
                  "package is not directly changed, so Vitest related has no local input files",
              },
            ],
          },
        ],
        fullPackageFilters: ["@repo/downstream"],
        relatedPackages: [{ files: ["src/feature.ts"], packageName: "@repo/app" }],
      });
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("ignores neutral documentation while selecting related source files", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "repo-tool-neutral-"));
    try {
      const appPath = path.join(repoRoot, "packages", "app");
      fs.mkdirSync(path.join(appPath, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(appPath, "package.json"),
        JSON.stringify({ name: "@repo/app", scripts: { test: "vitest run" } }),
      );
      fs.writeFileSync(path.join(appPath, "README.md"), "# App\n");
      fs.writeFileSync(path.join(appPath, "src", "feature.ts"), "export {};\n");

      expect(
        resolveRelatedTestPlan({
          changedFiles: ["packages/app/README.md", "packages/app/src/feature.ts"],
          directPackageNames: ["@repo/app"],
          repoRoot,
          selectedPackages: [{ name: "@repo/app", path: appPath }],
        }),
      ).toEqual({
        fallbacks: [],
        fullPackageFilters: [],
        relatedPackages: [{ files: ["src/feature.ts"], packageName: "@repo/app" }],
      });
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("skips tests for documentation-only package changes", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "repo-tool-neutral-only-"));
    try {
      const appPath = path.join(repoRoot, "packages", "app");
      fs.mkdirSync(appPath, { recursive: true });
      fs.writeFileSync(
        path.join(appPath, "package.json"),
        JSON.stringify({ name: "@repo/app", scripts: { test: "vitest run" } }),
      );
      fs.writeFileSync(path.join(appPath, "README.md"), "# App\n");

      expect(
        resolveRelatedTestPlan({
          changedFiles: ["packages/app/README.md"],
          directPackageNames: ["@repo/app"],
          repoRoot,
          selectedPackages: [{ name: "@repo/app", path: appPath }],
        }),
      ).toEqual({ fallbacks: [], fullPackageFilters: [], relatedPackages: [] });
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("reports actionable fallback reasons for entrypoints and deleted sources", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "repo-tool-fallback-"));
    try {
      const appPath = path.join(repoRoot, "packages", "app");
      fs.mkdirSync(path.join(appPath, "src", "cli"), { recursive: true });
      fs.writeFileSync(
        path.join(appPath, "package.json"),
        JSON.stringify({ name: "@repo/app", scripts: { test: "vitest run" } }),
      );
      fs.writeFileSync(path.join(appPath, "src", "cli", "index.ts"), "export {};\n");

      const plan = resolveRelatedTestPlan({
        changedFiles: ["packages/app/src/cli/index.ts", "packages/app/src/deleted.ts"],
        directPackageNames: ["@repo/app"],
        repoRoot,
        selectedPackages: [{ name: "@repo/app", path: appPath }],
      });

      expect(plan.fullPackageFilters).toEqual(["@repo/app"]);
      expect(plan.fallbacks).toEqual([
        {
          packageName: "@repo/app",
          reasons: [
            {
              code: "package-entrypoint",
              message: "package entrypoint can affect behavior outside Vitest's related graph",
              path: "src/cli/index.ts",
            },
            {
              code: "deleted-source",
              message: "deleted source file is absent from the current Vitest module graph",
              path: "src/deleted.ts",
            },
          ],
        },
      ]);
      expect(formatRelatedTestFallback(plan.fallbacks[0]!)).toEqual([
        "repo-tool verify: related tests fallback=@repo/app",
        "  src/cli/index.ts: package entrypoint can affect behavior outside Vitest's related graph",
        "  src/deleted.ts: deleted source file is absent from the current Vitest module graph",
      ]);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("verify failure projection", () => {
  it("keeps a bounded tail and marks omitted child output", () => {
    const compact = compactProcessOutput(
      Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"),
      { maxLines: 3 },
    );
    expect(compact).toEqual({
      text: "[repo-tool] earlier child output omitted\nline 18\nline 19\nline 20",
      truncated: true,
    });
  });

  it("removes successful Vitest files, repeated Turbo prefixes, and failure wrappers", () => {
    const output = [
      "• turbo 2.8.13",
      "• Packages in scope: @rejelly/app",
      "@rejelly/app:test: > @rejelly/app@0.0.0 test /repo/app",
      "@rejelly/app:test: > vitest run",
      "@rejelly/app:test:  ✓ src/passed.test.ts (3 tests) 10ms",
      "@rejelly/app:test: ",
      "@rejelly/app:test:  FAIL  src/failed.test.ts > example",
      "@rejelly/app:test: AssertionError: expected true to be false",
      "@rejelly/app:test: ",
      "@rejelly/app:test:  Test Files  1 failed | 205 passed (206)",
      "@rejelly/app:test:       Tests  1 failed | 1499 passed (1500)",
      "Tasks: 1 failed, 8 successful",
      "Cached: 6 cached, 9 total",
      "Time: 30.2s",
      "Failed: @rejelly/app#test",
      "ERROR: command finished with error: test exited (1)",
      "@rejelly/app#test: command test exited (1)",
      "ERROR run failed: command exited (1)",
      "ELIFECYCLE Test failed",
    ].join("\n");

    expect(formatFailureDiagnostics(output)).toBe(
      [
        "@rejelly/app test",
        "",
        " FAIL  src/failed.test.ts > example",
        "AssertionError: expected true to be false",
        "",
        " Test Files  1 failed | 205 passed (206)",
        "      Tests  1 failed | 1499 passed (1500)",
      ].join("\n"),
    );
  });

  it("extracts Turbo tasks and Vitest files without depending on ANSI formatting", () => {
    expect(
      extractFailureFacts(
        "\u001b[31mFAIL\u001b[39m src/a.test.ts > example\nFailed: @rejelly/app#test\n",
      ),
    ).toEqual({
      failedTasks: ["@rejelly/app#test"],
      failedTestFiles: ["src/a.test.ts"],
    });
  });
});
