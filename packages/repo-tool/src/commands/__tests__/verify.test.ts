import { describe, expect, it } from "vitest";
import type { VerifyOptions } from "../../contracts.js";
import { createVerifyPlan } from "../verify.js";

const defaults: VerifyOptions = {
  allowMany: false,
  biome: "changed",
  dryRun: false,
  maxFiles: 100,
  scope: { kind: "affected" },
  tests: true,
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
        { kind: "biome-changed", label: "Biome (changed files)" },
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
      {
        command: "pnpm",
        args: ["exec", "biome", "check", "."],
        kind: "process",
        label: "Biome (all files)",
      },
    ]);
  });

  it("skips Turbo when no changed file belongs to a workspace package", () => {
    const plan = createVerifyPlan(defaults, { kind: "none", source: "affected" });
    expect(plan.steps).toEqual([{ kind: "biome-changed", label: "Biome (changed files)" }]);
  });
});
