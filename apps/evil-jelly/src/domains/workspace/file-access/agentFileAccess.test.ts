import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { toolArtifacts } from "../../../shared/fs-policy/tool-artifacts";
import { getWorkspaceRoot, setWorkspaceRoot } from "../../../shared/fs-policy/workspace-context";
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

  it.each([
    "normal",
    "auto",
  ] as const)("allows only reads and scans of registered temp snapshots in %s mode", async (mode) => {
    const { root, access } = createAccess();
    const previous = getWorkspaceRoot();
    setWorkspaceRoot(root);
    try {
      const file = await toolArtifacts.saveText("saved page");
      const directory = path.dirname(file);
      expect(access.tryResolve(file, { kind: "read" }, mode).ok).toBe(true);
      expect(access.tryResolve(file, { kind: "scan" }, mode).ok).toBe(true);
      expect(access.tryResolve(directory, { kind: "scan" }, mode).ok).toBe(true);
      const write = access.tryResolve(file, { kind: "write" }, mode);
      expect(write.ok).toBe(false);
      if (!write.ok) expect(write.approval?.access).toBe("write");
      const otherTemp = access.tryResolve(os.tmpdir(), { kind: "scan" }, mode);
      expect(otherTemp.ok).toBe(false);
      if (!otherTemp.ok) expect(otherTemp.approval?.access).toBe("scan");
      const sensitive = access.tryResolve(path.join(directory, ".env"), { kind: "read" }, mode);
      expect(sensitive.ok).toBe(false);
      if (!sensitive.ok) expect(sensitive.error).toContain("sensitive");
    } finally {
      toolArtifacts.dispose();
      setWorkspaceRoot(previous);
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
