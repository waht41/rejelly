import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWorkspaceRoot, setWorkspaceRoot } from "../../../shared/fs-policy/workspace-context";
import { getWorkspaceFiles } from "../../../shared/fs-policy/workspace-files";
import type { EvilJellyBindings } from "../../../shared/host/bindings";
import type { FsOutsideAccessPayload } from "../../../shared/host/toolConfirmationBindings";
import { createTestHostBindings } from "../__tests__/testHostBindings";
import {
  ListDirTool,
  MAX_DIRECTORY_SCAN_ENTRIES,
  MAX_IGNORED_DIRECTORY_SCAN_ENTRIES,
  MAX_READ_BYTES_PER_CALL,
  MAX_READ_LINE_BYTES,
  ReadFileTool,
} from "./FileSystemTools";

const hostBindingMock = vi.hoisted(() => ({
  current: null as EvilJellyBindings | null,
}));

vi.mock("../../../shared/host/context", () => ({
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
    previousRoot = getWorkspaceRoot();
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
    expect(output).toContain('<file path="file-0.txt" path-scope="workspace">');
    expect(output).toContain('<file path="file-5.txt" path-scope="workspace">');
    expect(output).toContain("content-5");
  });

  it("reads exact gitignored and dependency files", async () => {
    await fs.mkdir(path.join(tmpDir, "local"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".gitignore"), "local/\nnode_modules/\n", "utf8");
    await fs.writeFile(path.join(tmpDir, "local", "settings.json"), '{"local":true}', "utf8");
    await fs.writeFile(
      path.join(tmpDir, "node_modules", "pkg", "index.js"),
      "export const dependency = true;",
      "utf8",
    );
    setWorkspaceRoot(tmpDir);

    const output = await ReadFileTool.handler({
      filePaths: ["local/settings.json", "node_modules/pkg/index.js"],
    });

    expect(output).toContain('{"local":true}');
    expect(output).toContain("export const dependency = true;");
  });

  it("lists ignored subtrees and the workspace root when explicitly requested", async () => {
    await fs.mkdir(path.join(tmpDir, "local", "nested"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".gitignore"), "local/\n", "utf8");
    await fs.writeFile(path.join(tmpDir, "local", "nested", "settings.json"), "{}", "utf8");
    setWorkspaceRoot(tmpDir);

    const hidden = await ListDirTool.handler({
      dirPath: "local",
      depth: 2,
      includeIgnored: false,
    });
    const listed = await ListDirTool.handler({
      dirPath: "local",
      depth: 2,
      includeIgnored: true,
    });
    const workspaceWide = await ListDirTool.handler({
      dirPath: ".",
      depth: 3,
      includeIgnored: true,
    });

    expect(hidden).toContain("only contains ignored folders");
    expect(listed).toContain("settings.json");
    expect(workspaceWide).toContain("settings.json");
  });

  it.each([
    ".agents",
    ".cursor",
    ".git",
  ])("reads and lists explicitly selected %s without exposing it in default scans", async (directory) => {
    await fs.mkdir(path.join(tmpDir, directory, "nested"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, directory, ".git"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, directory, "nested", "rules.md"), "config content");
    await fs.writeFile(path.join(tmpDir, directory, ".git", "hidden.md"), "nested metadata");
    await fs.writeFile(path.join(tmpDir, directory, ".env"), "SECRET=1");

    const defaultListing = await ListDirTool.handler({
      dirPath: ".",
      depth: 3,
      includeIgnored: false,
    });
    const hidden = await ListDirTool.handler({
      dirPath: directory,
      depth: 3,
      includeIgnored: false,
    });
    const listed = await ListDirTool.handler({
      dirPath: directory,
      depth: 3,
      includeIgnored: true,
    });
    const read = await ReadFileTool.handler({
      filePaths: [`${directory}/nested/rules.md`],
    });

    expect(defaultListing).not.toContain(directory);
    expect(hidden).toContain("includeIgnored: true");
    expect(listed).toContain("rules.md");
    expect(listed).not.toContain("hidden.md");
    expect(listed).not.toContain(".env");
    expect(read).toContain("config content");
  });

  it("lists dependency containers recursively within the entry budget", async () => {
    await fs.mkdir(path.join(tmpDir, "node_modules", "@scope", "pkg", "src"), {
      recursive: true,
    });
    await fs.writeFile(path.join(tmpDir, ".gitignore"), "node_modules/\n", "utf8");
    await fs.writeFile(
      path.join(tmpDir, "node_modules", "@scope", "pkg", "src", "index.ts"),
      "export {};",
      "utf8",
    );
    setWorkspaceRoot(tmpDir);

    const packageListing = await ListDirTool.handler({
      dirPath: "node_modules/@scope/pkg",
      depth: 2,
      includeIgnored: true,
    });
    const rootListing = await ListDirTool.handler({
      dirPath: "node_modules",
      depth: 1,
      includeIgnored: true,
    });

    const scopeListing = await ListDirTool.handler({
      dirPath: "node_modules/@scope",
      depth: 1,
      includeIgnored: true,
    });
    const recursiveRoot = await ListDirTool.handler({
      dirPath: "node_modules",
      depth: 2,
      includeIgnored: true,
    });
    const recursiveScope = await ListDirTool.handler({
      dirPath: "node_modules/@scope",
      depth: 3,
      includeIgnored: true,
    });
    const defaultListing = await ListDirTool.handler({
      dirPath: ".",
      depth: 3,
      includeIgnored: false,
    });

    expect(packageListing).toContain("index.ts");
    expect(rootListing).toContain("[dir]  @scope/");
    expect(rootListing).not.toContain("index.ts");
    expect(scopeListing).toContain("[dir]  pkg/");
    expect(scopeListing).not.toContain("src/");
    expect(recursiveRoot).toContain("pkg/");
    expect(recursiveScope).toContain("index.ts");
    expect(defaultListing).not.toContain("node_modules");
  });

  it("discovers pnpm packages and lists linked names without following them", async () => {
    const storePath = "node_modules/.pnpm/pkg@1.0.0";
    const packagePath = `${storePath}/node_modules/pkg`;
    await fs.mkdir(path.join(tmpDir, packagePath, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, packagePath, "src/index.ts"), "export {};");
    await fs.writeFile(path.join(tmpDir, "node_modules/.env"), "SECRET=1");
    await fs.mkdir(path.join(tmpDir, "node_modules/.git"));
    await fs.symlink(
      path.join(tmpDir, packagePath),
      path.join(tmpDir, "node_modules/pkg"),
      "junction",
    );

    const rootListing = await ListDirTool.handler({
      dirPath: "node_modules",
      depth: 1,
      includeIgnored: true,
    });
    const storeListing = await ListDirTool.handler({
      dirPath: "node_modules/.pnpm",
      depth: 1,
      includeIgnored: true,
    });
    const versionListing = await ListDirTool.handler({
      dirPath: storePath,
      depth: 1,
      includeIgnored: true,
    });
    const packageListing = await ListDirTool.handler({
      dirPath: packagePath,
      depth: 2,
      includeIgnored: true,
    });
    const linkedListing = await ListDirTool.handler({
      dirPath: "node_modules/pkg",
      depth: 2,
      includeIgnored: true,
    });
    const recursiveStore = await ListDirTool.handler({
      dirPath: "node_modules/.pnpm",
      depth: 2,
      includeIgnored: true,
    });

    expect(rootListing).toContain("[dir]  .pnpm/");
    expect(rootListing).toContain("[link] pkg");
    expect(rootListing).not.toContain("index.ts");
    expect(rootListing).not.toContain(".env");
    expect(rootListing).not.toContain(".git");
    expect(storeListing).toContain("[dir]  pkg@1.0.0/");
    expect(versionListing).toContain("[dir]  node_modules/");
    expect(packageListing).toContain("index.ts");
    expect(linkedListing).toContain("index.ts");
    expect(recursiveStore).toContain("pkg@1.0.0");
    expect(recursiveStore).not.toContain("concrete package");
  });

  it.each([
    false,
    true,
  ])("lists more than 200 entries without exhausting the budget (includeIgnored=%s)", async (includeIgnored) => {
    await fs.mkdir(path.join(tmpDir, "nested"));
    await Promise.all(
      Array.from({ length: 205 }, (_, index) =>
        fs.writeFile(path.join(tmpDir, "nested", `file-${index}.txt`), "content"),
      ),
    );
    const output = await ListDirTool.handler({ dirPath: ".", depth: 3, includeIgnored });
    expect(typeof output).toBe("string");
    const text = String(output);
    expect(text.match(/\[dir\]|\[file\]/g)).toHaveLength(206);
    expect(text).not.toContain("scan limit");
  });

  it.each([
    false,
    true,
  ])("stops at the whole-tree safety budget (includeIgnored=%s)", async (includeIgnored) => {
    const maxEntries = includeIgnored
      ? MAX_IGNORED_DIRECTORY_SCAN_ENTRIES
      : MAX_DIRECTORY_SCAN_ENTRIES;
    let inspected = 0;
    const iterate = vi
      .spyOn(getWorkspaceFiles(), "iterateDirectoryResolved")
      .mockImplementation(async function* (directory) {
        if (directory.rel === ".") {
          inspected += 1;
          yield { name: "nested", isDirectory: () => true };
          inspected += 1;
          yield { name: "root.txt", isDirectory: () => false };
        } else {
          for (let index = 0; index < maxEntries + 5; index++) {
            inspected += 1;
            yield { name: `file-${index}.txt`, isDirectory: () => false };
          }
        }
      });
    try {
      const output = await ListDirTool.handler({ dirPath: ".", depth: 3, includeIgnored });
      expect(inspected).toBe(maxEntries);
      expect(output).toContain("[file] root.txt");
      expect(output).toContain(`scan limit reached: ${maxEntries} directory entries`);
      expect(output).toContain("results may be incomplete");
    } finally {
      iterate.mockRestore();
    }
  });

  it.each([
    "dist",
    "build",
  ])("lists nested %s only when ignored traversal is requested", async (directory) => {
    await fs.mkdir(path.join(tmpDir, "pkg", directory), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "pkg", directory, "compiled.js"), "export {};");
    const hidden = await ListDirTool.handler({ dirPath: "pkg", depth: 2, includeIgnored: false });
    const listed = await ListDirTool.handler({ dirPath: "pkg", depth: 2, includeIgnored: true });
    expect(hidden).not.toContain("compiled.js");
    expect(listed).toContain("compiled.js");
  });

  it.each([2, 3])("traverses breadth-first with unambiguous paths at depth %s", async (depth) => {
    const visited: string[] = [];
    const iterate = vi
      .spyOn(getWorkspaceFiles(), "iterateDirectoryResolved")
      .mockImplementation(async function* (directory) {
        const relative = directory.rel.replace(/\\/g, "/");
        visited.push(relative);
        if (relative === ".") {
          yield { name: "first", isDirectory: () => true };
          yield { name: "second", isDirectory: () => true };
          yield { name: "root.txt", isDirectory: () => false };
        } else if (relative === "first") {
          yield { name: "deep", isDirectory: () => true };
          yield { name: "same.txt", isDirectory: () => false };
        } else {
          yield { name: "same.txt", isDirectory: () => false };
        }
      });
    try {
      const output = String(
        await ListDirTool.handler({ dirPath: ".", depth, includeIgnored: true }),
      );
      const expected = [
        "[dir]  first/",
        "[dir]  second/",
        "[file] root.txt",
        "  [dir]  first/deep/",
        "  [file] first/same.txt",
        "  [file] second/same.txt",
      ];
      if (depth === 3) {
        expected.push("    [file] first/deep/same.txt");
      }
      expect(output.split("\n").slice(1)).toEqual(expected);
      expect(visited).toEqual(
        depth === 3 ? [".", "first", "second", "first/deep"] : [".", "first", "second"],
      );
    } finally {
      iterate.mockRestore();
    }
  });

  it("continues queued siblings after an unreadable directory", async () => {
    const iterate = vi
      .spyOn(getWorkspaceFiles(), "iterateDirectoryResolved")
      .mockImplementation(async function* (directory) {
        if (directory.rel === ".") {
          yield { name: "unreadable", isDirectory: () => true };
          yield { name: "readable", isDirectory: () => true };
        } else if (directory.rel === "unreadable") {
          throw new Error("Access denied");
        } else {
          yield { name: "visible.txt", isDirectory: () => false };
        }
      });
    try {
      const output = await ListDirTool.handler({ dirPath: ".", depth: 2, includeIgnored: true });
      expect(output).toContain("[file] readable/visible.txt");
    } finally {
      iterate.mockRestore();
    }
  });

  it("does not report a scan limit for a small complete directory", async () => {
    await fs.writeFile(path.join(tmpDir, "small.txt"), "content");
    const output = await ListDirTool.handler({ dirPath: ".", depth: 1, includeIgnored: true });
    expect(output).toContain("small.txt");
    expect(output).not.toContain("scan limit");
  });

  it("reads a line range without adding line numbers to the file body", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i + 1}`);
    await fs.writeFile(path.join(tmpDir, "ranged.txt"), lines.join("\n"), "utf8");

    const output = await ReadFileTool.handler({
      filePaths: [{ path: "ranged.txt", offset: 10, limit: 3 }],
    });

    expect(output).toContain(
      '<file path="ranged.txt" path-scope="workspace" start-line="10" end-line="12" total-lines="50">',
    );
    expect(output).toContain("\nline-10\nline-11\nline-12\n</file>");
    expect(output).not.toContain("10\tline-10");
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
    expect(wholeRead).toContain('reason="combined-size-limit"');
    expect(wholeRead).toContain(`size-bytes="${Buffer.byteLength(bigContent, "utf8")}"`);
    expect(wholeRead).toContain(`max-call-bytes="${MAX_READ_BYTES_PER_CALL}"`);

    const rangedRead = await ReadFileTool.handler({
      filePaths: [{ path: "big.txt", offset: 5, limit: 2 }],
    });
    expect(rangedRead).toContain(
      `<file path="big.txt" path-scope="workspace" start-line="5" end-line="6" total-lines="${bigLineCount}">`,
    );
    expect(rangedRead).not.toContain("Error:");
  });

  it("rejects an offset past the end of the file", async () => {
    await fs.writeFile(path.join(tmpDir, "short.txt"), "a\nb\nc", "utf8");

    const output = await ReadFileTool.handler({
      filePaths: [{ path: "short.txt", offset: 10 }],
    });

    expect(output).toContain("Error: offset 10 is past the end of the file (3 lines).");
  });

  it("refuses an oversized line in a whole-file read", async () => {
    await fs.writeFile(
      path.join(tmpDir, "bundle.js"),
      `prefix\n${"x".repeat(MAX_READ_LINE_BYTES + 1)}`,
      "utf8",
    );

    const output = await ReadFileTool.handler({ filePaths: ["bundle.js"] });

    expect(output).toContain(`above the ${MAX_READ_LINE_BYTES / 1024} KB single-line limit`);
    expect(output).toContain('reason="oversized-line"');
    expect(output).toContain('offending-line="2"');
    expect(output).toContain(`line-bytes="${MAX_READ_LINE_BYTES + 1}"`);
    expect(output).toContain(`max-line-bytes="${MAX_READ_LINE_BYTES}"`);
    expect(output).toContain('total-lines="2"');
    expect(output).not.toContain("use grep");
    expect(output).not.toContain("x".repeat(100));
  });

  it("refuses an oversized line selected by a ranged read", async () => {
    await fs.writeFile(
      path.join(tmpDir, "long.log"),
      `short\n${"y".repeat(MAX_READ_LINE_BYTES + 1)}\ntail`,
      "utf8",
    );

    const output = await ReadFileTool.handler({
      filePaths: [{ path: "long.log", offset: 2, limit: 1 }],
    });

    expect(output).toContain("Line 2");
    expect(output).toContain("single-line limit");
    expect(output).toContain('reason="oversized-line"');
    expect(output).toContain('offending-line="2"');
    expect(output).toContain('total-lines="3"');
    expect(output).not.toContain("y".repeat(100));
  });

  it("rejects NUL-containing content as binary without consuming the batch budget", async () => {
    await fs.writeFile(path.join(tmpDir, "binary.dat"), "prefix\0payload", "utf8");
    const safeContent = Array.from({ length: 2048 }, () => "s".repeat(48)).join("\n");
    await fs.writeFile(path.join(tmpDir, "safe.txt"), safeContent, "utf8");

    const output = await ReadFileTool.handler({ filePaths: ["binary.dat", "safe.txt"] });

    expect(output).toContain('path="binary.dat"');
    expect(output).toContain('reason="binary-content"');
    expect(output).toContain('binary-signal="nul-byte"');
    expect(output).toContain('signal-count="1"');
    expect(output).toContain('path="safe.txt"');
    expect(output).toContain(safeContent.slice(0, 100));
  });

  it("rejects text with an abnormal control-character ratio", async () => {
    await fs.writeFile(path.join(tmpDir, "controls.txt"), "\u0001\u0002\u0003\u0004text", "utf8");

    const output = await ReadFileTool.handler({ filePaths: ["controls.txt"] });

    expect(output).toContain('reason="binary-content"');
    expect(output).toContain('binary-signal="control-characters"');
    expect(output).toContain('signal-count="4"');
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

    expect(output).toContain(
      '<file path="whole.txt" path-scope="workspace">\nwhole content\n</file>',
    );
    expect(output).toContain(
      '<file path="part.txt" path-scope="workspace" start-line="2" end-line="3" total-lines="4">',
    );
    expect(output).toContain("\np2\np3\n</file>");
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
      expect(outsideAccessRequests[0]?.access).toBe("read");
      expect(output).toContain(
        `<file path="${outsideFile.replace(/\\/g, "/")}" path-scope="absolute">`,
      );
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

  it("keeps closing tags and CDATA terminators unchanged in file content", async () => {
    const content = "before\n</file>\n]]>\nafter";
    await fs.writeFile(path.join(tmpDir, "boundary.txt"), content, "utf8");

    const output = await ReadFileTool.handler({ filePaths: ["boundary.txt"] });
    if (typeof output !== "string") {
      throw new TypeError("Expected read_file to return text");
    }
    const opening = output.match(
      /^<(file-[a-f0-9]{8}) path="boundary\.txt" path-scope="workspace">/,
    );

    expect(opening).not.toBeNull();
    expect(output).toContain(`\n${content}\n`);
    expect(output.endsWith(`</${opening?.[1]}>`)).toBe(true);
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
