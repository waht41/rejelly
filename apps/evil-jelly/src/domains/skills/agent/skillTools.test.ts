import { describe, expect, it, vi } from "vitest";
import { SKILL_CATALOG_LIMITS } from "../catalog/limits";
import { createSkillCatalog } from "../catalog/skillCatalog";
import type { SkillRecord, SkillResourceReadResult } from "../definition/skillDefinition";
import { skillOrigin } from "../definition/skillDefinition";
import { SKILL_AGENT_LIMITS } from "./limits";
import type { SkillRuntimeSnapshot } from "./skillRuntime";
import { createSkillTools } from "./skillTools";

function record(
  scope: "user" | "project",
  name: string,
  description = `Description for ${name}`,
): SkillRecord {
  return Object.freeze({
    name,
    description,
    origin: skillOrigin(scope),
    instruction: `Snapshot instruction for ${scope}:${name}`,
    resources: Object.freeze([
      Object.freeze({ path: "references/guide.md", kind: "reference", sizeBytes: 5 }),
    ]),
  });
}

function snapshot(
  records: readonly SkillRecord[],
  readText = vi.fn<SkillRuntimeSnapshot["resources"]["readText"]>(),
): { snapshot: SkillRuntimeSnapshot; readText: typeof readText } {
  return {
    snapshot: Object.freeze({
      catalog: createSkillCatalog(records),
      resources: Object.freeze({ readText }),
    }),
    readText,
  };
}

describe("Skill tools", () => {
  it("creates exactly the three Skill tools", () => {
    const built = snapshot([]);
    const tools = createSkillTools(built.snapshot);

    expect(Object.values(tools).map((tool) => tool.name)).toEqual([
      "read_skill",
      "list_skills",
      "read_skill_resource",
    ]);
    expect(Object.isFrozen(tools)).toBe(true);
  });

  it("returns snapshot instructions without touching the resource repository", async () => {
    const selected = record("project", "explain");
    const built = snapshot([selected]);
    const tools = createSkillTools(built.snapshot);

    const output = await tools.readSkill.handler({ skill: "explain" });

    expect(output).toContain("Snapshot instruction for project:explain");
    expect(output).toContain('qualified-name="project:explain"');
    expect(built.readText).not.toHaveBeenCalled();
  });

  it("returns stable ambiguity and not-found results instead of throwing", async () => {
    const built = snapshot([record("user", "review"), record("project", "review")]);
    const tools = createSkillTools(built.snapshot);

    await expect(tools.readSkill.handler({ skill: "review" })).resolves.toContain(
      'code="skill_ambiguous"',
    );
    await expect(tools.readSkill.handler({ skill: "missing" })).resolves.toContain(
      'code="skill_not_found"',
    );
  });

  it("lists deterministic bounded pages and rejects malformed or foreign cursors", async () => {
    const records = Array.from({ length: SKILL_CATALOG_LIMITS.listPageEntries + 1 }, (_, index) =>
      record("project", `skill-${index.toString().padStart(3, "0")}`, "x"),
    );
    const built = snapshot(records);
    const tools = createSkillTools(built.snapshot);

    const first = await tools.listSkills.handler({});

    expect(first).toContain("<skills ");
    expect(first).toContain('qualified-name="project:skill-000"');
    expect(first).not.toContain("Description for");
    expect(String(first).length).toBeLessThanOrEqual(SKILL_AGENT_LIMITS.listToolOutputChars);
    const cursor = /next-cursor="([^"]+)"/.exec(String(first))?.[1];
    expect(cursor).toBeTypeOf("string");
    await expect(tools.listSkills.handler({ cursor })).resolves.toContain(
      'qualified-name="project:skill-050"',
    );
    await expect(tools.listSkills.handler({ cursor: "bad" })).resolves.toContain(
      'code="invalid_cursor"',
    );
  });

  it("reads a canonical inventory resource and maps every repository failure", async () => {
    const selected = record("project", "review");
    let nextRead: SkillResourceReadResult = {
      ok: true,
      content: "guide",
      resource: selected.resources[0]!,
    };
    const built = snapshot(
      [selected],
      vi.fn(async () => nextRead),
    );
    const tools = createSkillTools(built.snapshot);

    const success = await tools.readSkillResource.handler({
      skill: "review",
      path: "references/guide.md",
    });
    expect(success).toContain('path="references/guide.md"');
    expect(success).toContain("guide");
    expect(built.readText).toHaveBeenCalledWith(selected, "references/guide.md");

    const failures = [
      ["resource-not-listed", "resource_not_listed"],
      ["resource-escape", "resource_escape"],
      ["resource-missing", "resource_missing"],
      ["resource-too-large", "resource_too_large"],
      ["unsupported-binary-resource", "unsupported_binary_resource"],
    ] as const;
    for (const [reason, code] of failures) {
      nextRead = { ok: false, reason, message: "Stable resource failure." };
      await expect(
        tools.readSkillResource.handler({ skill: "review", path: "references/guide.md" }),
      ).resolves.toContain(`code="${code}"`);
    }
  });

  it("resolves Skill errors before attempting any resource read", async () => {
    const built = snapshot([record("user", "review"), record("project", "review")]);
    const tools = createSkillTools(built.snapshot);

    await expect(
      tools.readSkillResource.handler({ skill: "review", path: "references/guide.md" }),
    ).resolves.toContain('code="skill_ambiguous"');
    expect(built.readText).not.toHaveBeenCalled();
  });
});
