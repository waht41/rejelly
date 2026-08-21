import { describe, expect, it } from "vitest";
import type { VerifyOptions } from "../../contracts.js";
import {
  assertFiltersMatched,
  compactProcessOutput,
  createVerifyPlan,
  extractFailureFacts,
  resolveAffectedScope,
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
  scope: { kind: "affected" },
  tests: true,
  verbose: false,
};

describe("createVerifyPlan", () => {
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

  it("writes with Biome before running workspace tasks when --fix is enabled", () => {
    const plan = createVerifyPlan(
      { ...defaults, fix: true },
      { filters: ["@rejelly/repo-tool"], kind: "packages", source: "explicit" },
    );

    expect(plan.steps[0]).toEqual({
      kind: "biome-changed",
      label: "Biome write (changed files)",
      write: true,
    });
    expect(plan.steps[1]?.label).toBe("workspace tasks");
  });

  it("skips Turbo when no changed file belongs to a workspace package", () => {
    const plan = createVerifyPlan(defaults, { kind: "none", source: "affected" });
    expect(plan.steps).toEqual([
      { kind: "biome-changed", label: "Biome check (changed files)", write: false },
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
