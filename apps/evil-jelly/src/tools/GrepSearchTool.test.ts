import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getWorkspaceFsPolicy,
  setWorkspaceRoot,
  TOOL_ALWAYS_IGNORED_DIR_NAMES,
} from "../shared/fs-policy/workspace-fs-policy";

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

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
    prevRoot = getWorkspaceFsPolicy().getRoot();
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
});
