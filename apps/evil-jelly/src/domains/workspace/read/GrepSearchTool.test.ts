import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWorkspaceRoot, setWorkspaceRoot } from "../../../shared/fs-policy/workspace-context";
import { TOOL_ALWAYS_IGNORED_DIR_NAMES } from "../../../shared/fs-policy/workspace-scan";
import type { EvilJellyBindings } from "../../../shared/host/bindings";
import type { FsOutsideAccessPayload } from "../../../shared/host/toolConfirmationBindings";
import { createTestHostBindings } from "../__tests__/testHostBindings";

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

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

afterEach(() => {
  hostBindingMock.current = null;
});

import {
  executeGrepSearch,
  GrepSearchTool,
  MAX_GREP_OUTPUT_BYTES,
  MAX_GREP_OUTPUT_LINE_BYTES,
} from "./GrepSearchTool";

describe("GrepSearchTool contextLines", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  it("uses default contextLines=3 in rg args", async () => {
    execFileSyncMock.mockReturnValue("src/file.ts:1:needle\n");

    const parsed = GrepSearchTool.parameters.parse({
      query: "needle",
    });
    const out = await GrepSearchTool.handler(parsed);

    expect(out).toContain("src/file.ts:1:needle");
    expect(execFileSyncMock).toHaveBeenCalledOnce();
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "rg",
      expect.arrayContaining(["-C", "3"]),
      expect.any(Object),
    );
  });

  it("derives ripgrep excluded directories from fs policy constants", async () => {
    execFileSyncMock.mockReturnValue("src/file.ts:1:needle\n");

    await executeGrepSearch("needle", "*.ts", 0);

    const args = execFileSyncMock.mock.calls[0]?.[1] as string[];
    for (const name of TOOL_ALWAYS_IGNORED_DIR_NAMES) {
      expect(args).toEqual(expect.arrayContaining(["--glob", `!${name}/**`]));
    }
  });

  it("derives git grep excluded directories from fs policy constants", async () => {
    const missingBinaryError = Object.assign(new Error("missing rg"), { code: "ENOENT" });
    execFileSyncMock.mockImplementationOnce(() => {
      throw missingBinaryError;
    });
    execFileSyncMock.mockReturnValueOnce("src/file.ts:1:needle\n");

    await executeGrepSearch("needle", "*.ts", 0);

    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    const gitArgs = execFileSyncMock.mock.calls[1]?.[1] as string[];
    for (const name of TOOL_ALWAYS_IGNORED_DIR_NAMES) {
      expect(gitArgs).toContain(`:(exclude)${name}`);
    }
  });

  it("uses case-insensitive ripgrep to match other grep backends", async () => {
    execFileSyncMock.mockReturnValue("src/file.ts:1:Needle\n");

    const out = await executeGrepSearch("needle", "*.ts", 0);

    expect(out).toContain("src/file.ts:1:Needle");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "rg",
      expect.arrayContaining(["-i"]),
      expect.any(Object),
    );
  });

  it("asks ripgrep to preview rather than emit unbounded source lines", async () => {
    execFileSyncMock.mockReturnValue("src/file.ts:1:needle\n");

    await executeGrepSearch("needle", "*.ts", 0);

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "rg",
      expect.arrayContaining([
        "--max-columns",
        String(MAX_GREP_OUTPUT_LINE_BYTES),
        "--max-columns-preview",
      ]),
      expect.any(Object),
    );
  });

  it("bounds native backend output lines while retaining their beginning and end", async () => {
    const longLine = `src/bundle.js:1:needle-${"x".repeat(MAX_GREP_OUTPUT_LINE_BYTES * 2)}-tail`;
    execFileSyncMock.mockReturnValue(`${longLine}\n`);

    const out = await executeGrepSearch("needle", "*.js", 0);

    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(MAX_GREP_OUTPUT_LINE_BYTES);
    expect(out).toContain("src/bundle.js:1:needle-");
    expect(out).toContain("[grep line truncated:");
    expect(out).toContain("-tail");
  });

  it("bounds the complete native backend response", async () => {
    const lines = Array.from(
      { length: 80 },
      (_, index) => `src/file-${index}.ts:1:needle-${"x".repeat(2000)}`,
    );
    execFileSyncMock.mockReturnValue(`${lines.join("\n")}\n`);

    const out = await executeGrepSearch("needle", "*.ts", 0);

    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(MAX_GREP_OUTPUT_BYTES);
    expect(out).toContain(`[grep output truncated at ${MAX_GREP_OUTPUT_BYTES} bytes;`);
    expect(out).toContain("narrow the query or file pattern");
  });

  it("accepts out-of-range contextLines in schema and clamps in handler", async () => {
    execFileSyncMock.mockReturnValue("src/file.ts:1:needle\n");

    const parsed = GrepSearchTool.parameters.parse({
      query: "needle",
      contextLines: 30,
    });
    const out = await GrepSearchTool.handler(parsed);

    expect(out).toContain("src/file.ts:1:needle");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "rg",
      expect.arrayContaining(["-C", "12"]),
      expect.any(Object),
    );
  });

  it("clamps executeGrepSearch contextLines to max 12", async () => {
    execFileSyncMock.mockReturnValue("src/file.ts:1:needle\n");

    const out = await executeGrepSearch("needle", "*.ts", 99);

    expect(out).toContain("src/file.ts:1:needle");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "rg",
      expect.arrayContaining(["-C", "12"]),
      expect.any(Object),
    );
  });
});

describe("GrepSearchTool Node fallback context merge", () => {
  let prevRoot: string;
  let tmpDir: string;

  beforeEach(async () => {
    execFileSyncMock.mockReset();
    prevRoot = getWorkspaceRoot();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "evil-jelly-grep-"));
    setWorkspaceRoot(tmpDir);
  });

  afterEach(async () => {
    setWorkspaceRoot(prevRoot);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("merges overlapping context windows and separates non-contiguous windows", async () => {
    const missingBinaryError = () =>
      Object.assign(new Error("missing binary"), {
        code: "ENOENT",
      });
    execFileSyncMock.mockImplementation(() => {
      throw missingBinaryError();
    });

    await fs.writeFile(
      path.join(tmpDir, "sample.ts"),
      [
        "line-1",
        "around-a",
        "needle",
        "middle",
        "needle",
        "around-b",
        "break",
        "around-c",
        "needle",
        "around-d",
      ].join("\n"),
      "utf8",
    );

    const out = await executeGrepSearch("needle", "*.ts", 1);

    expect(out).toContain("sample.ts-2-around-a");
    expect(out).toContain("sample.ts:3:needle");
    expect(out).toContain("sample.ts-4-middle");
    expect(out).toContain("sample.ts:5:needle");
    expect(out).toContain("sample.ts-6-around-b");
    expect(out).toContain("\n--\n");
    expect(out).toContain("sample.ts-8-around-c");
    expect(out).toContain("sample.ts:9:needle");
    expect(out).toContain("sample.ts-10-around-d");
  });

  it("bounds oversized matching lines in the Node fallback", async () => {
    const missingBinaryError = () =>
      Object.assign(new Error("missing binary"), {
        code: "ENOENT",
      });
    execFileSyncMock.mockImplementation(() => {
      throw missingBinaryError();
    });
    await fs.writeFile(
      path.join(tmpDir, "bundle.ts"),
      `needle-${"界".repeat(MAX_GREP_OUTPUT_LINE_BYTES)}-tail`,
      "utf8",
    );

    const out = await executeGrepSearch("needle", "*.ts", 0);

    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(MAX_GREP_OUTPUT_LINE_BYTES);
    expect(out).toContain("bundle.ts:1:needle-");
    expect(out).toContain("[grep line truncated:");
    expect(out).toContain("-tail");
    expect(out).not.toContain("�");
  });

  it("searches one explicit ignored subtree", async () => {
    await fs.mkdir(path.join(tmpDir, "local", "nested"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".gitignore"), "local/\n", "utf8");
    await fs.writeFile(
      path.join(tmpDir, "local", "nested", "settings.ts"),
      "export const ignoredNeedle = true;\n",
      "utf8",
    );
    setWorkspaceRoot(tmpDir);

    const out = await executeGrepSearch("ignoredNeedle", "*.ts", 0, {
      directory: "local",
      includeIgnored: true,
    });

    expect(out).toContain(
      `${path.join("local", "nested", "settings.ts")}:1:export const ignoredNeedle = true;`,
    );
  });

  it("confirms and searches an outside directory", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "evil-jelly-outside-grep-"));
    const outsideFile = path.join(outsideDir, "external.ts");
    const outsideAccessRequests: FsOutsideAccessPayload[] = [];
    hostBindingMock.current = createTestHostBindings({ mode: "normal", outsideAccessRequests });
    await fs.writeFile(outsideFile, "export const externalNeedle = true;\n", "utf8");

    try {
      const out = await executeGrepSearch("externalNeedle", "*.ts", 0, {
        directory: outsideDir,
      });

      expect(outsideAccessRequests).toHaveLength(1);
      expect(outsideAccessRequests[0]?.access).toBe("scan");
      expect(out).toContain(`${outsideFile}:1:export const externalNeedle = true;`);
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("requires a concrete package for ignored dependency searches", async () => {
    await fs.mkdir(path.join(tmpDir, "node_modules", "pkg", "src"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".gitignore"), "node_modules/\n", "utf8");
    await fs.writeFile(
      path.join(tmpDir, "node_modules", "pkg", "src", "index.ts"),
      "export const dependencyNeedle = true;\n",
      "utf8",
    );
    setWorkspaceRoot(tmpDir);

    const dependencyRoot = await executeGrepSearch("dependencyNeedle", "*.ts", 0, {
      directory: "node_modules",
      includeIgnored: true,
    });
    const packageResult = await executeGrepSearch("dependencyNeedle", "*.ts", 0, {
      directory: "node_modules/pkg",
      includeIgnored: true,
    });

    expect(dependencyRoot).toContain("concrete package");
    expect(packageResult).toContain("dependencyNeedle");
    expect(packageResult).toContain(path.join("node_modules", "pkg", "src", "index.ts"));
  });
});
