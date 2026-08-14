import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveContainedPath, validateRelativeSkillPath } from "./containedPath";

describe("Skill path boundary", () => {
  let fixtureRoot: string;
  let safeRoot: string;

  beforeEach(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evil-path-boundary-"));
    safeRoot = path.join(fixtureRoot, "safe");
    await fs.mkdir(path.join(safeRoot, "nested"), { recursive: true });
    await fs.writeFile(path.join(safeRoot, "nested", "file.md"), "safe");
  });

  afterEach(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it.each([
    "",
    " ",
    "\0bad",
    "/absolute",
    "C:\\absolute",
    "C:drive",
    "\\\\server\\share",
  ])("lexically rejects %j", (input) => {
    expect(validateRelativeSkillPath(input)).toBeTypeOf("string");
  });

  it("resolves contained files and directories", async () => {
    await expect(resolveContainedPath(safeRoot, "nested", "directory")).resolves.toMatchObject({
      ok: true,
      realPath: await fs.realpath(path.join(safeRoot, "nested")),
    });
    await expect(
      resolveContainedPath(safeRoot, path.join("nested", "file.md"), "file"),
    ).resolves.toMatchObject({ ok: true });
  });

  it("rejects lexical traversal outside the root", async () => {
    await expect(resolveContainedPath(safeRoot, "../outside.md", "file")).resolves.toMatchObject({
      ok: false,
      reason: "escape",
    });
  });

  it("allows an in-root file symlink but rejects an escaping file symlink", async () => {
    const outsideFile = path.join(fixtureRoot, "outside.md");
    await fs.writeFile(outsideFile, "outside");
    await fs.symlink(
      path.join(safeRoot, "nested", "file.md"),
      path.join(safeRoot, "inside-link.md"),
      "file",
    );
    await fs.symlink(outsideFile, path.join(safeRoot, "outside-link.md"), "file");

    await expect(resolveContainedPath(safeRoot, "inside-link.md", "file")).resolves.toMatchObject({
      ok: true,
    });
    await expect(resolveContainedPath(safeRoot, "outside-link.md", "file")).resolves.toMatchObject({
      ok: false,
      reason: "escape",
    });
  });

  it("does not traverse a directory symlink or junction", async () => {
    const target = path.join(fixtureRoot, "directory-target");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "file.md"), "outside");
    await fs.symlink(
      target,
      path.join(safeRoot, "directory-link"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      resolveContainedPath(safeRoot, path.join("directory-link", "file.md"), "file"),
    ).resolves.toMatchObject({ ok: false, reason: "symlink-directory" });
    await expect(
      resolveContainedPath(safeRoot, "directory-link", "directory"),
    ).resolves.toMatchObject({ ok: false, reason: "symlink-directory" });
  });
});
