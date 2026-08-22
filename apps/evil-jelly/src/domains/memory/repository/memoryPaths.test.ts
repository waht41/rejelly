import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMemoryPaths } from "./memoryPaths";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("persistent memory paths", () => {
  it("places user and project stores below the configured memory root", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "evil-memory-workspace-"));
    const memoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evil-memory-root-"));
    temporaryRoots.push(workspace, memoryRoot);
    const paths = resolveMemoryPaths(workspace, memoryRoot);
    expect(paths.userFile).toBe(path.join(memoryRoot, "user.json"));
    expect(path.dirname(paths.projectFile)).toContain(path.join(memoryRoot, "projects"));
    expect(path.relative(memoryRoot, paths.projectFile).startsWith("..")).toBe(false);
  });
});
