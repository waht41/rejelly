import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHostBindings } from "../__tests__/testHostBindings";
import type { FsOutsideAccessPayload } from "../shared/AgentShared";
import { getWorkspaceFsPolicy, setWorkspaceRoot } from "../shared/fs-policy/workspace-fs-policy";
import type { EvilJellyHostBindings } from "../shared/types";
import { MAX_READ_BYTES_PER_CALL, ReadFileTool } from "./FileSystemTools";

const hostBindingMock = vi.hoisted(() => ({
  current: null as EvilJellyHostBindings | null,
}));

vi.mock("../services/binding/hostBindings", () => ({
  getBinding: () => {
    if (!hostBindingMock.current) {
      throw new Error("No test host binding registered.");
    }
    return hostBindingMock.current;
  },
}));

describe("ReadFileTool", () => {
  let previousRoot: string;
  let tmpDir: string;

  beforeEach(async () => {
    previousRoot = getWorkspaceFsPolicy().getRoot();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "evil-jelly-read-file-"));
    setWorkspaceRoot(tmpDir);
  });

  afterEach(async () => {
    hostBindingMock.current = null;
    setWorkspaceRoot(previousRoot);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("allows more than five files and relies on the combined byte limit", async () => {
    const filePaths: string[] = [];
    for (let i = 0; i < 6; i++) {
      const filePath = `file-${i}.txt`;
      filePaths.push(filePath);
      await fs.writeFile(path.join(tmpDir, filePath), `content-${i}`, "utf8");
    }

    expect(ReadFileTool.parameters.safeParse({ filePaths }).success).toBe(true);

    const output = await ReadFileTool.handler({ filePaths });
    expect(output).toContain("--- FILE: file-0.txt ---");
    expect(output).toContain("--- FILE: file-5.txt ---");
    expect(output).toContain("content-5");
  });

  it("reads a line range with line numbers when offset/limit are given", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i + 1}`);
    await fs.writeFile(path.join(tmpDir, "ranged.txt"), lines.join("\n"), "utf8");

    const output = await ReadFileTool.handler({
      filePaths: [{ path: "ranged.txt", offset: 10, limit: 3 }],
    });

    expect(output).toContain("--- FILE: ranged.txt (lines 10-12 of 50) ---");
    expect(output).toContain("10\tline-10");
    expect(output).toContain("12\tline-12");
    expect(output).not.toContain("line-9");
    expect(output).not.toContain("line-13");
  });

  it("reads a range from a file above the whole-file byte limit", async () => {
    const bigLineCount = Math.ceil(MAX_READ_BYTES_PER_CALL / 100) + 100;
    const bigContent = Array.from({ length: bigLineCount }, (_, i) => `${"x".repeat(99)}${i}`).join(
      "\n",
    );
    await fs.writeFile(path.join(tmpDir, "big.txt"), bigContent, "utf8");

    const wholeRead = await ReadFileTool.handler({ filePaths: ["big.txt"] });
    expect(wholeRead).toContain("Error: Combined file sizes exceed");

    const rangedRead = await ReadFileTool.handler({
      filePaths: [{ path: "big.txt", offset: 5, limit: 2 }],
    });
    expect(rangedRead).toContain(`(lines 5-6 of ${bigLineCount}) ---`);
    expect(rangedRead).not.toContain("Error:");
  });

  it("rejects an offset past the end of the file", async () => {
    await fs.writeFile(path.join(tmpDir, "short.txt"), "a\nb\nc", "utf8");

    const output = await ReadFileTool.handler({
      filePaths: [{ path: "short.txt", offset: 10 }],
    });

    expect(output).toContain("Error: offset 10 is past the end of the file (3 lines).");
  });

  it("mixes plain paths and ranged entries in one call", async () => {
    await fs.writeFile(path.join(tmpDir, "whole.txt"), "whole content", "utf8");
    await fs.writeFile(path.join(tmpDir, "part.txt"), "p1\np2\np3\np4", "utf8");

    expect(
      ReadFileTool.parameters.safeParse({
        filePaths: ["whole.txt", { path: "part.txt", offset: 2, limit: 2 }],
      }).success,
    ).toBe(true);

    const output = await ReadFileTool.handler({
      filePaths: ["whole.txt", { path: "part.txt", offset: 2, limit: 2 }],
    });

    expect(output).toContain("--- FILE: whole.txt ---\nwhole content");
    expect(output).toContain("--- FILE: part.txt (lines 2-3 of 4) ---");
    expect(output).toContain("2\tp2");
    expect(output).not.toContain("p4");
  });

  it("confirms outside reads in normal mode", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "evil-jelly-outside-read-"));
    const outsideFile = path.join(outsideDir, "note.txt");
    await fs.writeFile(outsideFile, "outside content", "utf8");
    const outsideAccessRequests: FsOutsideAccessPayload[] = [];
    hostBindingMock.current = createTestHostBindings({ mode: "normal", outsideAccessRequests });

    try {
      const output = await ReadFileTool.handler({ filePaths: [outsideFile] });

      expect(outsideAccessRequests).toHaveLength(1);
      expect(outsideAccessRequests[0]?.mode).toBe("read");
      expect(output).toContain(`--- FILE: ${outsideFile} ---`);
      expect(output).toContain("outside content");
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("does not confirm outside non-sensitive reads in auto mode", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "evil-jelly-outside-auto-read-"));
    const outsideFile = path.join(outsideDir, "note.txt");
    await fs.writeFile(outsideFile, "outside content", "utf8");
    const outsideAccessRequests: FsOutsideAccessPayload[] = [];
    hostBindingMock.current = createTestHostBindings({ mode: "auto", outsideAccessRequests });

    try {
      const output = await ReadFileTool.handler({ filePaths: [outsideFile] });

      expect(outsideAccessRequests).toHaveLength(0);
      expect(output).toContain("outside content");
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects outside sensitive reads in auto mode", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "evil-jelly-outside-sensitive-"));
    const outsideFile = path.join(outsideDir, ".env");
    await fs.writeFile(outsideFile, "SECRET=1", "utf8");
    const outsideAccessRequests: FsOutsideAccessPayload[] = [];
    hostBindingMock.current = createTestHostBindings({ mode: "auto", outsideAccessRequests });

    try {
      const output = await ReadFileTool.handler({ filePaths: [outsideFile] });

      expect(outsideAccessRequests).toHaveLength(0);
      expect(output).toContain("sensitive");
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});
