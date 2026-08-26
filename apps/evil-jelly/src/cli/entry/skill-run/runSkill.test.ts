import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillRuntimeSnapshot } from "../../../domains/skills/agent/skillRuntime";
import { createSkillCatalog } from "../../../domains/skills/catalog/skillCatalog";
import { type SkillRecord, skillOrigin } from "../../../domains/skills/definition/skillDefinition";
import { runSkillCommand } from "./runSkill";

const mocks = vi.hoisted(() => ({
  buildConfiguredSkillRuntimeSnapshot: vi.fn(),
}));

vi.mock("../../skill-runtime/configuredRuntime", () => ({
  buildConfiguredSkillRuntimeSnapshot: mocks.buildConfiguredSkillRuntimeSnapshot,
}));

function record(scope: "user" | "project", name: string): SkillRecord {
  return {
    name,
    description: `Description for ${name}`,
    shortDescription: `Short ${name}`,
    origin: skillOrigin(scope),
    instruction: `Instruction for ${name}`,
    resources: [{ path: "references/guide.md", kind: "reference", sizeBytes: 42 }],
  };
}

function runtime(records: readonly SkillRecord[]): SkillRuntimeSnapshot {
  return {
    catalog: createSkillCatalog(records),
    access: {
      get(skill) {
        return {
          kind: "host-filesystem",
          rootPath: path.resolve("fixtures", "skills", skill.origin.scope, skill.name),
          mainResource: "SKILL.md",
          pathConvention: process.platform === "win32" ? "windows" : "posix",
        };
      },
    },
    resources: {
      async readText() {
        return { ok: false, reason: "resource-not-listed", message: "not used" };
      },
    },
  };
}

function prepare(records: readonly SkillRecord[], diagnostics: readonly object[] = []): void {
  mocks.buildConfiguredSkillRuntimeSnapshot.mockResolvedValue({
    snapshot: runtime(records),
    diagnostics,
  });
}

function printedJson(log: ReturnType<typeof vi.spyOn>): unknown {
  return JSON.parse(String(log.mock.calls[0]?.[0]));
}

describe("evil skills", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.buildConfiguredSkillRuntimeSnapshot.mockReset();
  });

  it("lists the effective Skill catalog without exposing instructions or paths", async () => {
    prepare([record("project", "review"), record("user", "explain")]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runSkillCommand({ action: "list" });

    expect(printedJson(log)).toMatchObject({
      type: "skill_list_v1",
      total: 2,
      skills: [
        { qualifiedName: "project:review", resourceCount: 1 },
        { qualifiedName: "user:explain", resourceCount: 1 },
      ],
    });
    expect(String(log.mock.calls[0]?.[0])).not.toContain("Instruction for");
    expect(String(log.mock.calls[0]?.[0])).not.toContain(`${path.sep}fixtures${path.sep}skills`);
  });

  it("shows absolute access paths and resource inventory for one Skill", async () => {
    prepare([record("project", "review")]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runSkillCommand({ action: "show", name: "project:review" });

    const expectedRoot = path.resolve("fixtures", "skills", "project", "review");
    expect(printedJson(log)).toMatchObject({
      type: "skill_v1",
      skill: {
        qualifiedName: "project:review",
        access: {
          rootPath: expectedRoot,
          mainPath: path.join(expectedRoot, "SKILL.md"),
          policy: "locator_only",
        },
        resources: [{ path: "references/guide.md", kind: "reference", sizeBytes: 42 }],
      },
    });
    expect(String(log.mock.calls[0]?.[0])).not.toContain("Instruction for review");
  });

  it("rejects ambiguous plain names with qualified candidates", async () => {
    prepare([record("project", "review"), record("user", "review")]);

    await expect(runSkillCommand({ action: "show", name: "review" })).rejects.toThrow(
      "project:review, user:review",
    );
  });

  it("prints fresh loader diagnostics with their source paths", async () => {
    prepare(
      [record("project", "review")],
      [
        {
          severity: "warning",
          code: "skill.frontmatter.invalid",
          message: "Invalid frontmatter",
          source: "C:\\skills\\broken\\SKILL.md",
          origin: { scope: "user" },
        },
      ],
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runSkillCommand({ action: "doctor" });

    expect(printedJson(log)).toMatchObject({
      type: "skill_doctor_v1",
      loaded: 1,
      warnings: 1,
      diagnostics: [
        {
          code: "skill.frontmatter.invalid",
          source: "C:\\skills\\broken\\SKILL.md",
        },
      ],
    });
    expect(mocks.buildConfiguredSkillRuntimeSnapshot).toHaveBeenCalledOnce();
  });
});
