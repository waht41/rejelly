import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { qualifiedSkillName, type SkillScope } from "./contracts";
import { SKILL_LIMITS } from "./limits";
import { loadLooseSkills } from "./loadLooseSkills";
import { discoverSkillSources, resolveSkillRoots } from "./skillSourceRoots";

describe("loose Skill source loading", () => {
  let fixtureRoot: string;
  let workspaceRoot: string;
  let globalJellyDir: string;

  beforeEach(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evil-loose-skills-"));
    workspaceRoot = path.join(fixtureRoot, "workspace");
    globalJellyDir = path.join(fixtureRoot, "global", ".evil-jelly");
    await fs.mkdir(workspaceRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  function skillRoot(scope: SkillScope): string {
    return scope === "user"
      ? path.join(globalJellyDir, "skills")
      : path.join(workspaceRoot, ".evil-jelly", "skills");
  }

  async function writeSkill(
    scope: SkillScope,
    directoryName: string,
    frontmatterName?: string,
    body = "body",
  ): Promise<string> {
    const directory = path.join(skillRoot(scope), directoryName);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, "SKILL.md"),
      `---\n${frontmatterName ? `name: ${frontmatterName}\n` : ""}description: ${directoryName}\n---\n${body}`,
    );
    return directory;
  }

  async function build() {
    const roots = resolveSkillRoots(workspaceRoot, globalJellyDir);
    const discovery = await discoverSkillSources(roots);
    const skills = await loadLooseSkills(discovery.sources);
    return {
      sources: discovery.sources,
      records: skills.records,
      resources: skills.resources,
      diagnostics: [...discovery.diagnostics, ...skills.diagnostics],
    };
  }

  it("loads healthy user and project Skills while isolating malformed siblings", async () => {
    await writeSkill("user", "user-good");
    await writeSkill("project", "project-good");
    const badDirectory = path.join(skillRoot("project"), "bad");
    await fs.mkdir(badDirectory, { recursive: true });
    await fs.writeFile(path.join(badDirectory, "SKILL.md"), "not frontmatter");

    const result = await build();

    expect(result.sources.map((source) => source.scope)).toEqual(["user", "project"]);
    expect(result.records.map(qualifiedSkillName)).toEqual([
      "project:project-good",
      "user:user-good",
    ]);
    expect(result.records.map((record) => record.origin.scope)).toEqual(["project", "user"]);
    expect(result.diagnostics.map((item) => item.code)).toContain("skill.frontmatter.invalid");
  });

  it("lets the same plain name coexist in different fixed sources", async () => {
    await writeSkill("user", "review");
    await writeSkill("project", "review");

    const result = await build();

    expect(result.records.map(qualifiedSkillName)).toEqual(["project:review", "user:review"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("rejects every duplicate qualified name without an ordering-dependent winner", async () => {
    await writeSkill("project", "first", "same-name");
    await writeSkill("project", "second", "same-name");

    const result = await build();

    expect(result.records).toEqual([]);
    expect(result.diagnostics.filter((item) => item.code === "skill.name.duplicate")).toHaveLength(
      2,
    );
  });

  it("rejects a Skill directory symlink or junction", async () => {
    const outside = path.join(fixtureRoot, "outside-skill");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "SKILL.md"), "---\ndescription: outside\n---\nbody");
    await fs.mkdir(skillRoot("project"), { recursive: true });
    await fs.symlink(
      outside,
      path.join(skillRoot("project"), "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const result = await build();

    expect(result.records).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "skill.directory.invalid", origin: { scope: "project" } }),
    ]);
  });

  it("reports source truncation separately from invalid Skill files", async () => {
    const root = skillRoot("project");
    await Promise.all(
      Array.from({ length: SKILL_LIMITS.skillsPerSource + 1 }, (_, index) =>
        fs.mkdir(path.join(root, `skill-${index.toString().padStart(3, "0")}`), {
          recursive: true,
        }),
      ),
    );

    const result = await build();

    expect(
      result.diagnostics.filter((item) => item.code === "skill.source.limit-exceeded"),
    ).toHaveLength(1);
    expect(result.diagnostics.filter((item) => item.code === "skill.file.invalid")).toHaveLength(
      SKILL_LIMITS.skillsPerSource,
    );
  });

  it("produces stable records and diagnostics across repeated snapshots", async () => {
    await writeSkill("project", "zeta");
    await writeSkill("user", "alpha");
    const broken = path.join(skillRoot("user"), "broken");
    await fs.mkdir(broken, { recursive: true });

    const first = await build();
    const second = await build();

    expect(first.records.map(qualifiedSkillName)).toEqual(["project:zeta", "user:alpha"]);
    expect(second.records).toEqual(first.records);
    expect(second.diagnostics).toEqual(first.diagnostics);
  });
});
