import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSkillRuntimeSnapshot,
  formatSkillRuntimeStartupSummary,
  isSkillEnabled,
} from "./skillRuntimeSnapshot";
import { createSkillTools } from "./skillTools";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fs.rm(fixture, { recursive: true })));
});

describe("SkillRuntimeSnapshot", () => {
  it("builds a catalog while keeping resource locations in a separate repository", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "evil-skill-snapshot-"));
    fixtures.push(root);
    const skill = path.join(root, "review");
    await fs.mkdir(path.join(skill, "references"), { recursive: true });
    await fs.writeFile(
      path.join(skill, "SKILL.md"),
      "---\ndescription: Review changes\n---\nUse the guide.",
    );
    await fs.writeFile(path.join(skill, "references", "guide.md"), "guide");

    const built = await buildSkillRuntimeSnapshot([{ scope: "project", rootPath: root }]);
    const tools = createSkillTools(built.snapshot);

    expect(built.diagnostics).toEqual([]);
    expect(formatSkillRuntimeStartupSummary(built)).toBe("Loaded 1 local Skill.");
    expect(built.snapshot.catalog.size).toBe(1);
    const resolved = built.snapshot.catalog.resolve("review");
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(JSON.stringify(resolved.skill)).not.toContain(root);
      await expect(
        built.snapshot.resources.readText(resolved.skill, "references/guide.md"),
      ).resolves.toEqual({
        ok: true,
        content: "guide",
        resource: { path: "references/guide.md", kind: "reference", sizeBytes: 5 },
      });
    }
    await fs.writeFile(
      path.join(skill, "SKILL.md"),
      "---\ndescription: Changed after startup\n---\nChanged instruction.",
    );
    const skillOutput = await tools.readSkill.handler({ skill: "review" });
    expect(skillOutput).toContain("Use the guide.");
    expect(skillOutput).not.toContain("Changed instruction.");
    expect(skillOutput).not.toContain(root);

    const resourceOutput = await tools.readSkillResource.handler({
      skill: "review",
      path: "references/guide.md",
    });
    expect(resourceOutput).toContain("guide");
    expect(resourceOutput).not.toContain(root);
    await expect(
      tools.readSkillResource.handler({ skill: "review", path: "../outside.md" }),
    ).resolves.toContain('code="resource_escape"');
    await expect(
      tools.readSkillResource.handler({ skill: "review", path: "references/unlisted.md" }),
    ).resolves.toContain('code="resource_not_listed"');
    expect(Object.isFrozen(built.snapshot)).toBe(true);
  });

  it("keeps the normal empty state silent and warning summaries path-free", async () => {
    const empty = await buildSkillRuntimeSnapshot([]);
    expect(formatSkillRuntimeStartupSummary(empty)).toBeUndefined();

    const source = "C:\\private\\skills\\broken";
    const summary = formatSkillRuntimeStartupSummary({
      snapshot: empty.snapshot,
      diagnostics: [
        {
          severity: "warning",
          code: "skill.source.invalid",
          message: "broken",
          source,
        },
      ],
    });
    expect(summary).toContain("skill.source.invalid: 1");
    expect(summary).not.toContain(source);
    expect(summary?.length).toBeLessThanOrEqual(1_000);
  });

  it("applies the master switch and qualified-name overrides", () => {
    const projectReview = { name: "review", origin: { scope: "project" as const } };

    expect(isSkillEnabled({ enabled: true, overrides: {} }, projectReview)).toBe(true);
    expect(
      isSkillEnabled(
        {
          enabled: true,
          overrides: { "project:review": { enabled: false } },
        },
        projectReview,
      ),
    ).toBe(false);
    expect(
      isSkillEnabled(
        {
          enabled: false,
          overrides: { "project:review": { enabled: true } },
        },
        projectReview,
      ),
    ).toBe(false);
  });

  it("filters disabled Skills before building the catalog", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "evil-skill-filter-"));
    fixtures.push(root);
    for (const name of ["enabled", "disabled"]) {
      const directory = path.join(root, name);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(
        path.join(directory, "SKILL.md"),
        `---\ndescription: ${name}\n---\n${name}`,
      );
    }

    const built = await buildSkillRuntimeSnapshot(
      [{ scope: "project", rootPath: root }],
      (skill) => skill.name !== "disabled",
    );

    expect(built.snapshot.catalog.size).toBe(1);
    expect(built.snapshot.catalog.resolve("enabled").ok).toBe(true);
    expect(built.snapshot.catalog.resolve("disabled")).toMatchObject({
      ok: false,
      reason: "not-found",
    });
  });
});
