import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getWorkspaceRoot, setWorkspaceRoot } from "../../../shared/fs-policy/workspace-context";
import {
  listScriptRelPathsUnder,
  listWorkspaceDocRelPaths,
  listWorkspaceScriptRelPaths,
} from "./workspacePaths";

describe("workspacePaths", () => {
  let previousRoot: string;
  let root: string;

  beforeEach(async () => {
    previousRoot = getWorkspaceRoot();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "evil-workspace-paths-"));
    await Promise.all([
      fs.mkdir(path.join(root, "packages", "src"), { recursive: true }),
      fs.mkdir(path.join(root, "docs", "draft"), { recursive: true }),
      fs.mkdir(path.join(root, "ignored"), { recursive: true }),
      fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true }),
      fs.mkdir(path.join(root, "dist"), { recursive: true }),
    ]);
    await fs.writeFile(path.join(root, ".gitignore"), "ignored/\n", "utf-8");
    await Promise.all([
      fs.writeFile(path.join(root, "packages", "src", "b.ts"), "export {}\n", "utf-8"),
      fs.writeFile(path.join(root, "packages", "src", "a.js"), "export {}\n", "utf-8"),
      fs.writeFile(path.join(root, "packages", "src", "note.md"), "note\n", "utf-8"),
      fs.writeFile(path.join(root, "ignored", "secret.ts"), "export {}\n", "utf-8"),
      fs.writeFile(path.join(root, "node_modules", "pkg", "index.ts"), "export {}\n", "utf-8"),
      fs.writeFile(path.join(root, "dist", "bundle.js"), "export {}\n", "utf-8"),
      fs.writeFile(path.join(root, "README.md"), "root\n", "utf-8"),
      fs.writeFile(path.join(root, "packages", "README-dev.md"), "package\n", "utf-8"),
      fs.writeFile(path.join(root, "docs", "guide.md"), "guide\n", "utf-8"),
      fs.writeFile(path.join(root, "docs", "draft", "wip.md"), "draft\n", "utf-8"),
    ]);
    setWorkspaceRoot(root);
  });

  afterEach(async () => {
    setWorkspaceRoot(previousRoot);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("lists script files through the bounded policy traversal", async () => {
    await expect(listWorkspaceScriptRelPaths()).resolves.toEqual([
      "packages/src/a.js",
      "packages/src/b.ts",
    ]);
  });

  it("keeps documentation selection in the workspace domain", async () => {
    await expect(listWorkspaceDocRelPaths()).resolves.toEqual([
      "README.md",
      "docs/guide.md",
      "packages/README-dev.md",
    ]);
  });

  it("supports directory and file roots without escaping the workspace", async () => {
    await expect(
      listScriptRelPathsUnder(["packages/src", "packages/src/b.ts", "../outside"]),
    ).resolves.toEqual(["packages/src/a.js", "packages/src/b.ts"]);
    await expect(listScriptRelPathsUnder(["packages/src"], 1)).resolves.toEqual([
      "packages/src/a.js",
    ]);
  });
});
