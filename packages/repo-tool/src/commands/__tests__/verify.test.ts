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
  it("combines repository tasks into one Turbo invocation", () => {
    expect(createVerifyPlan(defaults)).toEqual([
      {
        command: "pnpm",
        args: ["exec", "turbo", "run", "typecheck", "lint:jelly", "lint:doc", "test", "--affected"],
        kind: "process",
        label: "workspace tasks",
      },
      { kind: "biome-changed", label: "Biome (changed files)" },
    ]);
  });

  it("supports filtered checks without tests or Biome", () => {
    const plan = createVerifyPlan({
      ...defaults,
      biome: "skip",
      scope: { filters: ["@rejelly/evil-jelly"], kind: "filtered" },
      tests: false,
    });
    expect(plan).toEqual([
      {
        command: "pnpm",
        args: [
          "exec",
          "turbo",
          "run",
          "typecheck",
          "lint:jelly",
          "lint:doc",
          "--filter=@rejelly/evil-jelly",
        ],
        kind: "process",
        label: "workspace tasks",
      },
    ]);
  });

  it("runs the whole workspace and full Biome only when requested", () => {
    expect(createVerifyPlan({ ...defaults, biome: "all", scope: { kind: "all" } })).toEqual([
      {
        command: "pnpm",
        args: ["exec", "turbo", "run", "typecheck", "lint:jelly", "lint:doc", "test"],
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
});
