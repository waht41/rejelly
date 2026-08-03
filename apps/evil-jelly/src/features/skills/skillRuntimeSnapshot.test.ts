import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSkillRuntimeSnapshot } from "./skillRuntimeSnapshot";

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

    expect(built.diagnostics).toEqual([]);
    expect(built.snapshot.catalog.size).toBe(1);
    const resolved = built.snapshot.catalog.resolve("review");
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(JSON.stringify(resolved.skill)).not.toContain(root);
      await expect(
        built.snapshot.resources.readText(resolved.skill, "references/guide.md"),
      ).resolves.toEqual({ ok: true, content: "guide" });
    }
    expect(Object.isFrozen(built.snapshot)).toBe(true);
  });
});
