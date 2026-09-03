import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverSkillSources,
  type ResolvedSkillRoots,
  resolveSkillRoots,
} from "./skillSourceRoots";

describe("loose Skill source roots", () => {
  let fixtureRoot: string;
  let workspaceRoot: string;
  let globalJellyDir: string;

  beforeEach(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evil-skill-roots-"));
    workspaceRoot = path.join(fixtureRoot, "workspace");
    globalJellyDir = path.join(fixtureRoot, "global", ".evil-jelly");
    await fs.mkdir(workspaceRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  function roots(): ResolvedSkillRoots {
    return resolveSkillRoots(workspaceRoot, globalJellyDir);
  }

  it("resolves Evil-specific and portable .agents roots without creating them", async () => {
    const resolved = roots();

    expect(resolved.roots).toEqual([
      { scope: "user", path: path.join(globalJellyDir, "skills") },
      { scope: "user", path: path.join(path.dirname(globalJellyDir), ".agents", "skills") },
      { scope: "project", path: path.join(workspaceRoot, ".evil-jelly", "skills") },
      { scope: "project", path: path.join(workspaceRoot, ".agents", "skills") },
    ]);
    await expect(fs.access(globalJellyDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.roots)).toBe(true);
  });

  it("does not reinterpret user Skill roots as project scope in a home workspace", () => {
    const homeWorkspace = path.dirname(globalJellyDir);

    expect(resolveSkillRoots(homeWorkspace, globalJellyDir).roots).toEqual([
      { scope: "user", path: path.join(globalJellyDir, "skills") },
      { scope: "user", path: path.join(homeWorkspace, ".agents", "skills") },
    ]);
  });

  it("treats missing roots as an empty, diagnostic-free result", async () => {
    await expect(discoverSkillSources(roots())).resolves.toEqual({
      sources: [],
      diagnostics: [],
    });
  });

  it("discovers existing roots in stable user/project order", async () => {
    const userRoot = path.join(globalJellyDir, "skills");
    const userAgentsRoot = path.join(path.dirname(globalJellyDir), ".agents", "skills");
    const projectRoot = path.join(workspaceRoot, ".evil-jelly", "skills");
    const projectAgentsRoot = path.join(workspaceRoot, ".agents", "skills");
    await fs.mkdir(userRoot, { recursive: true });
    await fs.mkdir(userAgentsRoot, { recursive: true });
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(projectAgentsRoot, { recursive: true });

    const result = await discoverSkillSources(roots());

    expect(result.sources).toEqual([
      { scope: "user", rootPath: await fs.realpath(userRoot) },
      { scope: "user", rootPath: await fs.realpath(userAgentsRoot) },
      { scope: "project", rootPath: await fs.realpath(projectRoot) },
      { scope: "project", rootPath: await fs.realpath(projectAgentsRoot) },
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("deduplicates canonical roots and retains the first scope identity", async () => {
    const userRoot = path.join(globalJellyDir, "skills");
    const projectState = path.join(workspaceRoot, ".evil-jelly");
    await fs.mkdir(userRoot, { recursive: true });
    await fs.mkdir(projectState, { recursive: true });
    await fs.symlink(
      userRoot,
      path.join(projectState, "skills"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const result = await discoverSkillSources(roots());

    expect(result.sources).toEqual([{ scope: "user", rootPath: await fs.realpath(userRoot) }]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "skill.source.duplicate" }),
    ]);
  });

  it("isolates an invalid root while retaining a healthy source", async () => {
    await fs.mkdir(globalJellyDir, { recursive: true });
    await fs.writeFile(path.join(globalJellyDir, "skills"), "not a directory");
    const projectRoot = path.join(workspaceRoot, ".evil-jelly", "skills");
    await fs.mkdir(projectRoot, { recursive: true });

    const result = await discoverSkillSources(roots());

    expect(result.sources).toEqual([
      { scope: "project", rootPath: await fs.realpath(projectRoot) },
    ]);
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "skill.source.invalid" })]);
  });
});
