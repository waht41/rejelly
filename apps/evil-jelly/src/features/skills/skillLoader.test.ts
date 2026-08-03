import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SKILL_LIMITS } from "./limits";
import { loadSkill, type SkillLoadCandidate } from "./skillLoader";
import { createSkillResourceRepository } from "./skillResourceRepository";

describe("skill loader and resource repository", () => {
  let fixtureRoot: string;
  let skillRoot: string;

  beforeEach(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evil-skill-loader-"));
    skillRoot = path.join(fixtureRoot, "review-code");
    await fs.mkdir(skillRoot);
  });

  afterEach(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  function candidate(): SkillLoadCandidate {
    return {
      scope: "project",
      directoryName: "review-code",
      directoryPath: skillRoot,
    };
  }

  async function writeSkill(body = "Use the reference.\n"): Promise<void> {
    await fs.writeFile(
      path.join(skillRoot, "SKILL.md"),
      `---\ndescription: Review code safely\nfuture-field: retained\n---\n${body}`,
    );
  }

  it("loads a path-free record with a stable, recursively sorted resource inventory", async () => {
    await writeSkill();
    await fs.mkdir(path.join(skillRoot, "references", "nested"), { recursive: true });
    await fs.writeFile(path.join(skillRoot, "references", "z.md"), "z");
    await fs.writeFile(path.join(skillRoot, "references", "nested", "a.md"), "a");
    await fs.mkdir(path.join(skillRoot, "assets"));
    await fs.writeFile(path.join(skillRoot, "assets", "image.bin"), Buffer.from([0, 1, 2]));

    const loaded = await loadSkill(candidate());

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    expect(loaded.skill.record).toEqual({
      name: "review-code",
      description: "Review code safely",
      origin: { scope: "project" },
      instruction: "Use the reference.\n",
      resources: [
        { path: "assets/image.bin", kind: "asset", sizeBytes: 3 },
        { path: "references/nested/a.md", kind: "reference", sizeBytes: 1 },
        { path: "references/z.md", kind: "reference", sizeBytes: 1 },
      ],
    });
    expect(loaded.skill.record).not.toHaveProperty("rootRealPath");
    expect(JSON.stringify(loaded.skill.record)).not.toContain(fixtureRoot);
    expect(loaded.skill.extras).toEqual({ "future-field": "retained" });
  });

  it("rejects oversized and invalid UTF-8 SKILL.md files", async () => {
    await fs.writeFile(
      path.join(skillRoot, "SKILL.md"),
      Buffer.alloc(SKILL_LIMITS.skillFileBytes + 1, 0x20),
    );
    await expect(loadSkill(candidate())).resolves.toMatchObject({
      ok: false,
      diagnostics: [{ code: "skill.file.too-large" }],
    });

    await fs.writeFile(path.join(skillRoot, "SKILL.md"), Buffer.from([0xff, 0xfe]));
    await expect(loadSkill(candidate())).resolves.toMatchObject({
      ok: false,
      diagnostics: [{ code: "skill.file.invalid" }],
    });
  });

  it("skips escaping resource links and never traverses directory junctions", async () => {
    await writeSkill();
    const outsideFile = path.join(fixtureRoot, "outside.md");
    const outsideDirectory = path.join(fixtureRoot, "outside-directory");
    await fs.writeFile(outsideFile, "outside");
    await fs.mkdir(outsideDirectory);
    await fs.mkdir(path.join(skillRoot, "references"));
    await fs.symlink(outsideFile, path.join(skillRoot, "references", "escape.md"), "file");
    await fs.symlink(
      outsideDirectory,
      path.join(skillRoot, "assets"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const loaded = await loadSkill(candidate());

    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.skill.record.resources).toEqual([]);
      expect(loaded.diagnostics.map((item) => item.code)).toEqual([
        "skill.resource.escape",
        "skill.resource.escape",
      ]);
    }
  });

  it("rechecks containment and text limits when a listed resource is read", async () => {
    await writeSkill();
    const referenceDirectory = path.join(skillRoot, "references");
    const referencePath = path.join(referenceDirectory, "guide.md");
    await fs.mkdir(referenceDirectory);
    await fs.writeFile(referencePath, "guide");
    const loaded = await loadSkill(candidate());
    if (!loaded.ok) {
      throw new Error("fixture skill failed to load");
    }
    const repository = createSkillResourceRepository([loaded.skill.location]);

    await expect(repository.readText(loaded.skill.record, "references/guide.md")).resolves.toEqual({
      ok: true,
      content: "guide",
      resource: { path: "references/guide.md", kind: "reference", sizeBytes: 5 },
    });
    await expect(repository.readText(loaded.skill.record, "../outside.md")).resolves.toMatchObject({
      ok: false,
      reason: "resource-escape",
    });

    const outside = path.join(fixtureRoot, "replacement.md");
    await fs.writeFile(outside, "outside");
    await fs.rm(referencePath);
    await fs.symlink(outside, referencePath, "file");
    await expect(
      repository.readText(loaded.skill.record, "references/guide.md"),
    ).resolves.toMatchObject({
      ok: false,
      reason: "resource-escape",
    });

    await fs.rm(referencePath);
    await fs.writeFile(referencePath, Buffer.alloc(SKILL_LIMITS.resourceReadBytes + 1, 0x20));
    await expect(
      repository.readText(loaded.skill.record, "references/guide.md"),
    ).resolves.toMatchObject({
      ok: false,
      reason: "resource-too-large",
    });

    await fs.writeFile(referencePath, Buffer.from([0xff, 0xfe]));
    await expect(
      repository.readText(loaded.skill.record, "references/guide.md"),
    ).resolves.toMatchObject({
      ok: false,
      reason: "unsupported-binary-resource",
    });
  });

  it("treats a record from outside the snapshot as a broken invariant", async () => {
    await writeSkill();
    const loaded = await loadSkill(candidate());
    if (!loaded.ok) {
      throw new Error("fixture skill failed to load");
    }
    const repository = createSkillResourceRepository([]);

    await expect(repository.readText(loaded.skill.record, "references/guide.md")).rejects.toThrow(
      /not part of this snapshot/,
    );
  });

  it("truncates the inventory at its boundaries instead of discarding the skill", async () => {
    await writeSkill();
    const references = path.join(skillRoot, "references");
    await fs.mkdir(references);
    for (let index = 0; index <= SKILL_LIMITS.resourcesPerSkill; index++) {
      await fs.writeFile(path.join(references, `${index.toString().padStart(3, "0")}.md`), "x");
    }

    const overCount = await loadSkill(candidate());

    // The instruction body is the point of a skill; an over-long resource list is not a reason
    // to make the whole thing vanish.
    expect(overCount.ok).toBe(true);
    if (overCount.ok) {
      expect(overCount.skill.record.resources).toHaveLength(SKILL_LIMITS.resourcesPerSkill);
      expect(overCount.skill.record.instruction).toBe("Use the reference.\n");
    }
    expect(overCount.diagnostics.map((item) => item.code)).toContain(
      "skill.resource.limit-exceeded",
    );

    await fs.rm(references, { recursive: true });
    let current = references;
    for (let depth = 0; depth <= SKILL_LIMITS.resourceDirectoryDepth; depth++) {
      current = path.join(current, `level-${depth}`);
    }
    await fs.mkdir(current, { recursive: true });
    await fs.writeFile(path.join(current, "deep.md"), "deep");
    await fs.writeFile(path.join(references, "shallow.md"), "shallow");

    const overDepth = await loadSkill(candidate());

    expect(overDepth.ok).toBe(true);
    if (overDepth.ok) {
      // Siblings above the depth boundary still list; only the deeper subtree is dropped.
      expect(overDepth.skill.record.resources.map((item) => item.path)).toEqual([
        "references/shallow.md",
      ]);
    }
    expect(overDepth.diagnostics.map((item) => item.code)).toContain(
      "skill.resource.limit-exceeded",
    );
  });
});
