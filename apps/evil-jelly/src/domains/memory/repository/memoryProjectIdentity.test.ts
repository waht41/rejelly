import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memoryProjectBucket, resolveMemoryProjectIdentity } from "./memoryProjectIdentity";

const temporaryRoots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evil-memory-identity-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("persistent memory project identity", () => {
  it("shares a normal git repository identity with nested workspaces", async () => {
    const root = await temporaryDirectory();
    await fs.mkdir(path.join(root, ".git"));
    const nested = path.join(root, "packages", "app");
    await fs.mkdir(nested, { recursive: true });

    const rootIdentity = resolveMemoryProjectIdentity(root);
    const nestedIdentity = resolveMemoryProjectIdentity(nested);
    expect(nestedIdentity).toEqual(rootIdentity);
    expect(rootIdentity.kind).toBe("git");
  });

  it("uses the same project name and bucket for main checkouts and linked worktrees", async () => {
    const root = await temporaryDirectory();
    const repository = path.join(root, "repository");
    const common = path.join(repository, ".git");
    const worktree = path.join(root, "worktree");
    const gitDirectory = path.join(common, "worktrees", "feature");
    await fs.mkdir(gitDirectory, { recursive: true });
    await fs.mkdir(repository, { recursive: true });
    await fs.mkdir(worktree, { recursive: true });
    await fs.writeFile(path.join(gitDirectory, "commondir"), "../..\n");
    await fs.writeFile(path.join(worktree, ".git"), `gitdir: ${gitDirectory}\n`);

    const mainIdentity = resolveMemoryProjectIdentity(repository);
    const worktreeIdentity = resolveMemoryProjectIdentity(worktree);
    expect(worktreeIdentity.kind).toBe(mainIdentity.kind);
    expect(worktreeIdentity.canonicalIdentity).toBe(mainIdentity.canonicalIdentity);
    expect(worktreeIdentity.projectName).toBe("repository");
    expect(worktreeIdentity.projectName).toBe(mainIdentity.projectName);
    expect(memoryProjectBucket(worktreeIdentity)).toBe(memoryProjectBucket(mainIdentity));
  });

  it("uses a sanitized name and an eight-character sha1 identity suffix", async () => {
    const root = await temporaryDirectory();
    const repository = path.join(root, "repo with spaces");
    await fs.mkdir(path.join(repository, ".git"), { recursive: true });

    const identity = resolveMemoryProjectIdentity(repository);
    const expectedDigest = crypto
      .createHash("sha1")
      .update(`${identity.kind}\0${identity.canonicalIdentity}`)
      .digest("hex")
      .slice(0, 8);

    expect(memoryProjectBucket(identity)).toBe(`repo_with_spaces-${expectedDigest}`);
    expect(memoryProjectBucket(identity)).toMatch(/^repo_with_spaces-[0-9a-f]{8}$/);
  });

  it("isolates non-git workspaces by canonical root", async () => {
    const root = await temporaryDirectory();
    const nested = path.join(root, "nested");
    await fs.mkdir(nested);
    const identity = resolveMemoryProjectIdentity(root);
    const nestedIdentity = resolveMemoryProjectIdentity(nested);
    expect(identity.kind).toBe("workspace");
    expect(identity.canonicalIdentity).not.toBe(nestedIdentity.canonicalIdentity);
  });
});
