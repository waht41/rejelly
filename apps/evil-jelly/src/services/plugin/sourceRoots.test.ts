import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverExtensionSources,
  type ResolvedExtensionRoots,
  resolveExtensionRoots,
} from "./sourceRoots";

describe("extension source roots", () => {
  let fixtureRoot: string;
  let workspaceRoot: string;
  let globalJellyDir: string;

  beforeEach(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evil-extension-roots-"));
    workspaceRoot = path.join(fixtureRoot, "workspace");
    globalJellyDir = path.join(fixtureRoot, "global", ".evil-jelly");
    await fs.mkdir(workspaceRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  function roots(): ResolvedExtensionRoots {
    return resolveExtensionRoots(workspaceRoot, globalJellyDir);
  }

  it("resolves exactly four fixed roots without creating them", async () => {
    const resolved = roots();

    expect(resolved.roots).toEqual([
      { scope: "user", kind: "plugin", path: path.join(globalJellyDir, "plugins") },
      {
        scope: "project",
        kind: "plugin",
        path: path.join(workspaceRoot, ".evil-jelly", "plugins"),
      },
      { scope: "user", kind: "loose-skill", path: path.join(globalJellyDir, "skills") },
      {
        scope: "project",
        kind: "loose-skill",
        path: path.join(workspaceRoot, ".evil-jelly", "skills"),
      },
    ]);
    await expect(fs.access(globalJellyDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.roots)).toBe(true);
  });

  it("treats four missing roots as an empty, diagnostic-free result", async () => {
    await expect(discoverExtensionSources(roots())).resolves.toEqual({
      plugins: [],
      looseSkills: [],
      diagnostics: [],
    });
  });

  it("discovers only marked direct child directories in stable order", async () => {
    const userPlugins = path.join(globalJellyDir, "plugins");
    const projectSkills = path.join(workspaceRoot, ".evil-jelly", "skills");
    await fs.mkdir(path.join(userPlugins, "z-plugin"), { recursive: true });
    await fs.writeFile(path.join(userPlugins, "z-plugin", "plugin.jsonc"), "not parsed in phase 1");
    await fs.mkdir(path.join(userPlugins, "a-plugin"), { recursive: true });
    await fs.writeFile(path.join(userPlugins, "a-plugin", "plugin.jsonc"), "{");
    await fs.mkdir(path.join(userPlugins, "unmarked"), { recursive: true });
    await fs.mkdir(path.join(userPlugins, "nested", "child"), { recursive: true });
    await fs.writeFile(path.join(userPlugins, "nested", "child", "plugin.jsonc"), "{}");
    await fs.writeFile(path.join(userPlugins, "standalone.jsonc"), "{}");

    await fs.mkdir(path.join(projectSkills, "z-skill"), { recursive: true });
    await fs.writeFile(path.join(projectSkills, "z-skill", "SKILL.md"), "z");
    await fs.mkdir(path.join(projectSkills, "a-skill"), { recursive: true });
    await fs.writeFile(path.join(projectSkills, "a-skill", "SKILL.md"), "a");
    await fs.mkdir(path.join(projectSkills, "unmarked"), { recursive: true });
    await fs.writeFile(path.join(projectSkills, "root.md"), "ignored");

    const result = await discoverExtensionSources(roots());

    expect(result.plugins.map((candidate) => candidate.directoryName)).toEqual([
      "a-plugin",
      "z-plugin",
    ]);
    expect(result.plugins.every((candidate) => candidate.scope === "user")).toBe(true);
    expect(result.looseSkills.map((candidate) => candidate.directoryName)).toEqual([
      "a-skill",
      "z-skill",
    ]);
    expect(result.looseSkills.every((candidate) => candidate.scope === "project")).toBe(true);
    expect(new Set(result.looseSkills.map((candidate) => candidate.sourceId)).size).toBe(1);
    expect(result.looseSkills[0]?.sourceId).toMatch(/^project-[a-f0-9]{8}$/);
    expect(result.diagnostics).toEqual([]);
  });

  it("diagnoses plugin.json and still accepts plugin.jsonc when both exist", async () => {
    const pluginRoot = path.join(globalJellyDir, "plugins");
    await fs.mkdir(path.join(pluginRoot, "json-only"), { recursive: true });
    await fs.writeFile(path.join(pluginRoot, "json-only", "plugin.json"), "{}");
    await fs.mkdir(path.join(pluginRoot, "both"), { recursive: true });
    await fs.writeFile(path.join(pluginRoot, "both", "plugin.json"), "{}");
    await fs.writeFile(path.join(pluginRoot, "both", "plugin.jsonc"), "{}");

    const result = await discoverExtensionSources(roots());

    expect(result.plugins.map((candidate) => candidate.directoryName)).toEqual(["both"]);
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "plugin.manifest.unsupported-filename",
      "plugin.manifest.unsupported-filename",
    ]);
    expect(result.diagnostics[0]?.message).toContain("ignored");
    expect(result.diagnostics[1]?.message).toContain("rename");
  });

  it("deduplicates symlinked canonical roots and retains the first scope identity", async () => {
    const userPluginRoot = path.join(globalJellyDir, "plugins");
    const userSkillRoot = path.join(globalJellyDir, "skills");
    const pluginDirectory = path.join(userPluginRoot, "shared-plugin");
    const skillDirectory = path.join(userSkillRoot, "shared-skill");
    await fs.mkdir(pluginDirectory, { recursive: true });
    await fs.writeFile(path.join(pluginDirectory, "plugin.jsonc"), "{}");
    await fs.mkdir(skillDirectory, { recursive: true });
    await fs.writeFile(path.join(skillDirectory, "SKILL.md"), "skill");
    const projectStateDir = path.join(workspaceRoot, ".evil-jelly");
    await fs.mkdir(projectStateDir, { recursive: true });
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await fs.symlink(userPluginRoot, path.join(projectStateDir, "plugins"), linkType);
    await fs.symlink(userSkillRoot, path.join(projectStateDir, "skills"), linkType);

    const result = await discoverExtensionSources(roots());

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]?.scope).toBe("user");
    expect(result.looseSkills).toHaveLength(1);
    expect(result.looseSkills[0]?.scope).toBe("user");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "plugin.source.duplicate",
      "plugin.source.duplicate",
    ]);
  });

  it("isolates an invalid root while continuing discovery in healthy roots", async () => {
    await fs.mkdir(globalJellyDir, { recursive: true });
    await fs.writeFile(path.join(globalJellyDir, "plugins"), "not a directory");
    const projectPlugin = path.join(workspaceRoot, ".evil-jelly", "plugins", "healthy-plugin");
    await fs.mkdir(projectPlugin, { recursive: true });
    await fs.writeFile(path.join(projectPlugin, "plugin.jsonc"), "{}");

    const result = await discoverExtensionSources(roots());

    expect(result.plugins.map((candidate) => candidate.directoryName)).toEqual(["healthy-plugin"]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: "plugin.source.missing",
      source: path.join(globalJellyDir, "plugins"),
    });
  });
});
