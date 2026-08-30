import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMemoryProjectIdentity } from "./memoryProjectIdentity";

const temporaryRoots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evil-memory-identity-"));
  temporaryRoots.push(root);
  return root;
}

async function resolve(root: string, memoryRoot: string) {
  return resolveMemoryProjectIdentity(root, memoryRoot);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("persistent memory project identity", () => {
  it("creates a stable project for a non-git workspace and its nested directories", async () => {
    const root = await temporaryDirectory();
    const memoryRoot = await temporaryDirectory();
    const nested = path.join(root, "packages", "app");
    await fs.mkdir(nested, { recursive: true });

    const rootIdentity = await resolve(root, memoryRoot);
    const nestedIdentity = await resolve(nested, memoryRoot);

    expect(rootIdentity.projectId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(nestedIdentity).toEqual(rootIdentity);
  });

  it("keeps home as a special exact-match project without capturing child projects", async () => {
    const home = await temporaryDirectory();
    const memoryRoot = await temporaryDirectory();
    const repository = path.join(home, "repository");
    await fs.mkdir(path.join(repository, ".git"), { recursive: true });
    vi.spyOn(os, "homedir").mockReturnValue(home);

    const homeIdentity = await resolve(home, memoryRoot);
    const repositoryIdentity = await resolve(repository, memoryRoot);

    expect(homeIdentity).toMatchObject({ root: await fs.realpath(home), kind: "home" });
    expect(repositoryIdentity).toMatchObject({
      root: await fs.realpath(repository),
      kind: "standard",
    });
    expect(repositoryIdentity.projectId).not.toBe(homeIdentity.projectId);
  });

  it("migrates a legacy home boundary in place and preserves its memory project id", async () => {
    const home = await temporaryDirectory();
    const memoryRoot = await temporaryDirectory();
    const repository = path.join(home, "repository");
    const projectId = "11111111-1111-4111-8111-111111111111";
    const registryPath = path.join(memoryRoot, "projects", "registry.json");
    const homeMemoryPath = path.join(memoryRoot, "projects", projectId, "memory.json");
    await fs.mkdir(path.join(repository, ".git"), { recursive: true });
    await fs.mkdir(path.dirname(homeMemoryPath), { recursive: true });
    await fs.writeFile(
      registryPath,
      `${JSON.stringify({
        version: 1,
        projects: [{ projectId, root: home, createdAt: "2026-01-01T00:00:00.000Z" }],
      })}\n`,
    );
    await fs.writeFile(homeMemoryPath, '{"version":1,"entries":[]}\n');
    vi.spyOn(os, "homedir").mockReturnValue(home);

    const homeIdentity = await resolve(home, memoryRoot);
    const repositoryIdentity = await resolve(repository, memoryRoot);
    const migratedRegistry = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      version: number;
      projects: Array<{ projectId: string; kind: string }>;
    };

    expect(homeIdentity).toMatchObject({ projectId, kind: "home" });
    expect(repositoryIdentity.projectId).not.toBe(projectId);
    expect(migratedRegistry.version).toBe(2);
    expect(migratedRegistry.projects).toContainEqual(
      expect.objectContaining({ projectId, kind: "home" }),
    );
    await expect(fs.readFile(homeMemoryPath, "utf8")).resolves.toContain('"entries":[]');
  });

  it("uses the nearest registered project and never merges nested projects", async () => {
    const root = await temporaryDirectory();
    const memoryRoot = await temporaryDirectory();
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    await fs.mkdir(first);
    await fs.mkdir(second);

    const firstIdentity = await resolve(first, memoryRoot);
    const secondIdentity = await resolve(second, memoryRoot);
    const rootIdentity = await resolve(root, memoryRoot);

    expect(firstIdentity.projectId).not.toBe(secondIdentity.projectId);
    expect(rootIdentity.projectId).not.toBe(firstIdentity.projectId);
    expect(rootIdentity.projectId).not.toBe(secondIdentity.projectId);
    expect(await resolve(path.join(first, "nested"), memoryRoot)).toEqual(firstIdentity);
    expect(await resolve(path.join(second, "nested"), memoryRoot)).toEqual(secondIdentity);
  });

  it("treats Windows separator, case, and trailing-separator variants as one project", async () => {
    if (process.platform !== "win32") return;

    const root = await temporaryDirectory();
    const memoryRoot = await temporaryDirectory();
    const variants = [root, `${root.toUpperCase()}\\`, root.replaceAll("\\\\", "/")];
    const identities = [];
    for (const variant of variants) {
      identities.push(await resolve(variant, memoryRoot));
    }

    expect(identities[1]).toEqual(identities[0]);
    expect(identities[2]).toEqual(identities[0]);
    expect(identities[0]!.root).not.toMatch(/[\\\\/]$/);
    expect(identities[0]!.root).toContain("\\");
  });

  it("uses git only to discover an unregistered project root", async () => {
    const root = await temporaryDirectory();
    const memoryRoot = await temporaryDirectory();
    const repository = path.join(root, "repository");
    const nested = path.join(repository, "packages", "app");
    await fs.mkdir(path.join(repository, ".git"), { recursive: true });
    await fs.mkdir(nested, { recursive: true });

    const identity = await resolve(nested, memoryRoot);
    expect(identity.root).toBe(await fs.realpath(repository));
    expect(identity.projectName).toBe("repository");
    expect(await resolve(repository, memoryRoot)).toEqual(identity);
  });

  it("keeps the project id when git is initialized after registration", async () => {
    const root = await temporaryDirectory();
    const memoryRoot = await temporaryDirectory();
    const beforeGit = await resolve(root, memoryRoot);
    await fs.mkdir(path.join(root, ".git"));

    const afterGit = await resolve(path.join(root, "packages", "api"), memoryRoot);

    expect(afterGit).toEqual(beforeGit);
  });

  it("shares the registered project between a main checkout and linked worktree", async () => {
    const root = await temporaryDirectory();
    const memoryRoot = await temporaryDirectory();
    const repository = path.join(root, "repository");
    const common = path.join(repository, ".git");
    const worktree = path.join(root, "worktree");
    const gitDirectory = path.join(common, "worktrees", "feature");
    await fs.mkdir(gitDirectory, { recursive: true });
    await fs.mkdir(repository, { recursive: true });
    await fs.mkdir(worktree, { recursive: true });
    await fs.writeFile(path.join(gitDirectory, "commondir"), "../..\n");
    await fs.writeFile(path.join(worktree, ".git"), `gitdir: ${gitDirectory}\n`);

    const mainIdentity = await resolve(repository, memoryRoot);
    const worktreeIdentity = await resolve(worktree, memoryRoot);

    expect(worktreeIdentity).toEqual(mainIdentity);
  });
});
