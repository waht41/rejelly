import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getProjectTempRoot } from "../../../shared/fs-policy/workspace-context";
import { WorkspaceFiles } from "../../../shared/fs-policy/workspace-files";
import { AgentFileAccess } from "./agentFileAccess";

function createAccess(): { root: string; access: AgentFileAccess } {
  const root = path.join(os.tmpdir(), `evil-jelly-agent-files-${Date.now()}-${Math.random()}`);
  return { root, access: new AgentFileAccess(new WorkspaceFiles(root)) };
}

describe("AgentFileAccess", () => {
  it("requires approval for outside reads in normal mode", () => {
    const { root, access } = createAccess();
    const outsideDir = path.resolve(root, "../shared-zone");
    const outsideFile = path.join(outsideDir, "README.md");
    const hit = access.tryResolve(outsideFile, { kind: "read" }, "normal");

    if (hit.ok) {
      throw new Error("expected outside read to require approval");
    }
    expect(hit.approval).toEqual({
      access: "read",
      targetPath: outsideFile,
      grantRoot: outsideDir,
    });
  });

  it("allows outside non-sensitive reads in auto mode", () => {
    const { root, access } = createAccess();
    const outsideFile = path.resolve(root, "../shared-zone/README.md");
    const hit = access.tryResolve(outsideFile, { kind: "read" }, "auto");

    expect(hit.ok).toBe(true);
    if (hit.ok) {
      expect(hit.outside).toBe(true);
      expect(hit.displayPath).toBe(outsideFile);
      expect(path.isAbsolute(hit.rel)).toBe(false);
      expect(hit.rel).not.toBe(outsideFile);
    }
  });

  it("denies outside sensitive files even in auto mode", () => {
    const { root, access } = createAccess();
    const outsideFile = path.resolve(root, "../shared-zone/.env");
    const hit = access.tryResolve(outsideFile, { kind: "read" }, "auto");

    if (hit.ok) {
      throw new Error("expected sensitive outside read to be denied");
    }
    expect(hit.approval).toBeUndefined();
    expect(hit.error).toContain("sensitive");
  });

  it("requires approval for outside writes even in auto mode", () => {
    const { root, access } = createAccess();
    const outsideFile = path.resolve(root, "../shared-zone/new.txt");
    const hit = access.tryResolve(outsideFile, { kind: "write" }, "auto");

    if (hit.ok) {
      throw new Error("expected outside write to require approval");
    }
    expect(hit.approval?.access).toBe("write");
  });

  it("treats the project temp directory like the workspace without registering files", () => {
    const { root, access } = createAccess();
    const temporary = getProjectTempRoot(root);
    for (const kind of ["read", "scan", "write"] as const) {
      const result = access.tryResolve(path.join(temporary, "existing.md"), { kind }, "normal");
      expect(result.ok).toBe(true);
    }
    for (const [relative, kind] of [
      [".env", "read"],
      ["node_modules/pkg/index.js", "write"],
      [".git/config", "write"],
      ["dist", "scan"],
    ] as const) {
      expect(access.tryResolve(path.join(temporary, relative), { kind }, "normal").ok).toBe(
        access.tryResolve(path.join(root, relative), { kind }, "normal").ok,
      );
    }
    expect(access.tryResolve(path.dirname(temporary), { kind: "scan" }, "normal").ok).toBe(false);
    expect(
      access.tryResolve(getProjectTempRoot(`${root}-other`), { kind: "write" }, "normal").ok,
    ).toBe(false);
  });

  it("does not extend project-temp permissions through a junction", async () => {
    const { root, access } = createAccess();
    const temporary = getProjectTempRoot(root);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "evil-temp-escape-"));
    await fs.mkdir(temporary, { recursive: true });
    await fs.symlink(outside, path.join(temporary, "escape"), "junction");
    try {
      const hit = access.tryResolve(
        path.join(temporary, "escape", "missing.md"),
        { kind: "write" },
        "normal",
      );
      expect(hit.ok).toBe(false);
      if (!hit.ok) expect(hit.error).toContain("outside the project temp workspace");
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("keeps outside read, scan, and write grants least-privileged", () => {
    const { root, access } = createAccess();
    const outsideDir = path.resolve(root, "../shared-zone");
    const outsideFile = path.join(outsideDir, "README.md");

    access.approveExternalAccess("read", outsideDir);
    expect(access.tryResolve(outsideDir, { kind: "scan" }, "normal").ok).toBe(false);

    access.approveExternalAccess("write", outsideDir);
    expect(access.tryResolve(outsideDir, { kind: "scan" }, "normal").ok).toBe(false);
    expect(access.tryResolve(outsideFile, { kind: "read" }, "normal").ok).toBe(true);
    expect(access.tryResolve(outsideFile, { kind: "write" }, "normal").ok).toBe(true);

    access.approveExternalAccess("scan", outsideDir);
    expect(access.tryResolve(outsideDir, { kind: "scan" }, "normal").ok).toBe(true);
  });
});
