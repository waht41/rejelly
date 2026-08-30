import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isHomeWorkspace, resolveWorkspaceScopePaths, sameCanonicalPath } from "./workspaceScope";

const temporaryRoots: string[] = [];

function temporaryDirectory(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("workspace scope paths", () => {
  it("suppresses project state when the workspace is home", () => {
    const home = temporaryDirectory("evil-scope-home-");
    const scope = resolveWorkspaceScopePaths(home, path.join(home, ".evil-jelly"));

    expect(scope.hasDistinctProjectState).toBe(false);
    expect(isHomeWorkspace(home, home)).toBe(true);
  });

  it("keeps a normal workspace project state distinct", () => {
    const home = temporaryDirectory("evil-scope-home-");
    const workspace = temporaryDirectory("evil-scope-workspace-");

    expect(
      resolveWorkspaceScopePaths(workspace, path.join(home, ".evil-jelly")).hasDistinctProjectState,
    ).toBe(true);
  });

  it("recognizes symlink aliases and missing descendants canonically", () => {
    const root = temporaryDirectory("evil-scope-alias-");
    const target = path.join(root, "target");
    const alias = path.join(root, "alias");
    fs.mkdirSync(target);
    fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");

    expect(sameCanonicalPath(path.join(alias, "missing"), path.join(target, "missing"))).toBe(true);
  });
});
