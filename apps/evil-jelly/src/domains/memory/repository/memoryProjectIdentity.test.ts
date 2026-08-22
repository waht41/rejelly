import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
