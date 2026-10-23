import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getProjectTempRoot,
  getWorkspaceRoot,
  setWorkspaceRoot,
} from "../../shared/fs-policy/workspace-context";
import { getWorkspaceFiles } from "../../shared/fs-policy/workspace-files";
import { createTestHostBindings } from "../workspace/__tests__/testHostBindings";
import { ListDirTool, ReadFileTool } from "../workspace/read/FileSystemTools";
import { FuzzySearchTool } from "../workspace/read/FuzzySearchTool";
import { executeGrepSearch } from "../workspace/read/GrepSearchTool";
import { createEditFileTool } from "../workspace/write/WriteTools";
import { ReadWebpageTool } from "./readWebpageTool";
import { MAX_WEBPAGE_OUTPUT_BYTES } from "./webpageOutput";

const mocks = vi.hoisted(() => ({ readWebpage: vi.fn(), confirmTool: vi.fn() }));
vi.mock("./index", () => ({
  readWebpage: mocks.readWebpage,
  HttpError: class HttpError extends Error {},
}));
vi.mock("../../shared/host/context", () => ({
  getBinding: () => ({
    ...createTestHostBindings({ mode: "normal" }),
    confirmTool: mocks.confirmTool,
  }),
}));

const page = {
  title: "Page",
  url: "https://example.test/page",
  markdown: "Short text",
  truncated: false,
};
let previousRoot: string;
let workspace: string;
beforeEach(async () => {
  previousRoot = getWorkspaceRoot();
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "evil-webpage-test-"));
  setWorkspaceRoot(workspace);
  mocks.readWebpage.mockReset().mockResolvedValue(page);
  mocks.confirmTool.mockReset().mockResolvedValue({ action: "reject" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  setWorkspaceRoot(previousRoot);
  await fs.rm(getProjectTempRoot(workspace), { recursive: true, force: true });
  await fs.rm(workspace, { recursive: true, force: true });
});

function savedPath(output: string): string {
  const file = output.match(/^Saved Markdown: (.+)$/m)?.[1];
  expect(file).toBeDefined();
  return file!;
}

function expectBounded(output: string): void {
  expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(MAX_WEBPAGE_OUTPUT_BYTES);
  expect(output).not.toContain("�");
}

describe("read_webpage bounded output and project-temp continuation", () => {
  it("keeps pages inline through the exact output boundary without writing a snapshot", async () => {
    const small = String(await ReadWebpageTool.handler({ url: page.url }));
    const overhead = Buffer.byteLength(small, "utf8") - Buffer.byteLength(page.markdown, "utf8");
    mocks.readWebpage.mockResolvedValue({
      ...page,
      markdown: "x".repeat(MAX_WEBPAGE_OUTPUT_BYTES - overhead),
    });
    const exact = String(await ReadWebpageTool.handler({ url: page.url }));
    expect(Buffer.byteLength(exact, "utf8")).toBe(MAX_WEBPAGE_OUTPUT_BYTES);
    await expect(fs.stat(getProjectTempRoot(workspace))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("saves one snapshot that all file tools can use, including an ordinary reviewed write", async () => {
    const markdown = `${"A paragraph with ordinary text.\n".repeat(12000)}TAIL_NEEDLE\n`;
    mocks.readWebpage.mockResolvedValue({ ...page, markdown, truncated: true });
    const output = String(await ReadWebpageTool.handler({ url: page.url }));
    expectBounded(output);
    expect(output).toContain("Output truncated: yes");
    expect(output).toContain("Source fetch truncated: yes");
    expect(output).not.toContain("TAIL_NEEDLE");
    const file = savedPath(output);
    const root = getProjectTempRoot(workspace);
    expect(path.dirname(file)).toBe(root);
    expect(await fs.readFile(file, "utf8")).toBe(markdown);
    expect(await executeGrepSearch("TAIL_NEEDLE", undefined, 1, { directory: file })).toContain(
      "> 12001 | TAIL_NEEDLE",
    );
    const read = String(
      await ReadFileTool.handler({ filePaths: [{ path: file, offset: 12001, limit: 1 }] }),
    );
    expect(read).toContain('path-scope="absolute"');
    expect(read).toContain("TAIL_NEEDLE");
    expect(
      String(await ListDirTool.handler({ dirPath: root, depth: 1, includeIgnored: false })),
    ).toContain(path.basename(file));
    expect(
      String(
        await FuzzySearchTool.handler({
          keyword: path.basename(file),
          directory: root,
          includeIgnored: false,
        }),
      ),
    ).toContain(file.replace(/\\/g, "/"));
    const review = vi.fn().mockResolvedValue({ action: "accept" });
    await createEditFileTool(review).handler({
      targets: [
        { filePath: file, edits: [{ searchBlock: "TAIL_NEEDLE", replaceBlock: "UPDATED_TAIL" }] },
      ],
    });
    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({ type: "fs_write", outsideWorkspace: false }),
    );
    expect(await fs.readFile(file, "utf8")).toContain("UPDATED_TAIL");
    expect(mocks.confirmTool).not.toHaveBeenCalled();
  });

  it("bounds metadata and wraps pathological Unicode lines into a readable snapshot without dropping text", async () => {
    const markdown = "界😀".repeat(20000);
    mocks.readWebpage.mockResolvedValue({
      ...page,
      title: "界😀".repeat(20000),
      url: `https://example.test/${"x".repeat(50000)}`,
      markdown,
    });
    const output = String(await ReadWebpageTool.handler({ url: page.url }));
    expectBounded(output);
    const file = savedPath(output);
    const text = await fs.readFile(file, "utf8");
    expect(text.replace(/\n/g, "")).toBe(markdown);
    expect(output).toContain("Long lines wrapped for reading: yes");
    const read = String(
      await ReadFileTool.handler({ filePaths: [{ path: file, offset: 1, limit: 1 }] }),
    );
    expect(read).toContain("界😀");
    expect(read).not.toContain("Error:");
  });

  it("keeps save/fetch/empty-page failures bounded and never advertises an unsaved file", async () => {
    vi.spyOn(getWorkspaceFiles(), "writeNewFile").mockRejectedValue(
      new Error("disk failure ".repeat(20000)),
    );
    mocks.readWebpage.mockResolvedValue({ ...page, markdown: "text\n".repeat(15000) });
    const unsaved = String(await ReadWebpageTool.handler({ url: page.url }));
    expectBounded(unsaved);
    expect(unsaved).toContain("omitted content was not saved");
    expect(unsaved).not.toContain("Saved Markdown:");
    mocks.readWebpage.mockRejectedValue(new Error("界😀".repeat(50000)));
    const failed = String(await ReadWebpageTool.handler({ url: page.url }));
    expectBounded(failed);
    expect(failed).toContain("read_webpage failed:");
    mocks.readWebpage.mockResolvedValue({ ...page, url: "界".repeat(50000), markdown: "" });
    const empty = String(await ReadWebpageTool.handler({ url: page.url }));
    expectBounded(empty);
    expect(empty).toContain("empty body");
  });
});
