import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toolArtifacts } from "../../shared/fs-policy/tool-artifacts";
import { getWorkspaceRoot, setWorkspaceRoot } from "../../shared/fs-policy/workspace-context";
import { workspaceBucket } from "../../shared/workspaceBucket";
import { createTestHostBindings } from "../workspace/__tests__/testHostBindings";
import { ListDirTool, ReadFileTool } from "../workspace/read/FileSystemTools";
import { resetFuzzySearchCache } from "../workspace/read/FuzzySearchService";
import { FuzzySearchTool } from "../workspace/read/FuzzySearchTool";
import { executeGrepSearch } from "../workspace/read/GrepSearchTool";
import { ReadWebpageTool } from "./readWebpageTool";
import { MAX_WEBPAGE_OUTPUT_BYTES } from "./webpageOutput";

const mocks = vi.hoisted(() => ({
  readWebpage: vi.fn(),
  confirmTool: vi.fn(),
  mode: "normal" as "normal" | "auto",
}));
vi.mock("./index", () => ({
  readWebpage: mocks.readWebpage,
  HttpError: class HttpError extends Error {},
}));
vi.mock("../../shared/host/context", () => ({
  getBinding: () => ({
    ...createTestHostBindings({ mode: mocks.mode }),
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
beforeEach(() => {
  previousRoot = getWorkspaceRoot();
  mocks.readWebpage.mockReset().mockResolvedValue(page);
  mocks.confirmTool.mockReset().mockResolvedValue({ action: "reject" });
  mocks.mode = "normal";
});
afterEach(() => {
  setWorkspaceRoot(previousRoot);
  resetFuzzySearchCache();
  vi.restoreAllMocks();
  toolArtifacts.dispose();
});

function savedPath(output: string): string {
  const file = output.match(/^Saved Markdown: (.+)$/m)?.[1];
  expect(file).toBeDefined();
  return file!;
}

describe("read_webpage bounded output and temp snapshots", () => {
  it("keeps short pages inline without disk IO, including the exact output boundary", async () => {
    const save = vi.spyOn(toolArtifacts, "saveText");
    const small = String(await ReadWebpageTool.handler({ url: page.url }));
    expect(small).toContain("Short text");
    expect(small).toContain("untrusted external data");
    const overhead = Buffer.byteLength(small, "utf8") - Buffer.byteLength(page.markdown, "utf8");
    mocks.readWebpage.mockResolvedValue({
      ...page,
      markdown: "x".repeat(MAX_WEBPAGE_OUTPUT_BYTES - overhead),
    });
    const exact = String(await ReadWebpageTool.handler({ url: page.url }));
    expect(Buffer.byteLength(exact, "utf8")).toBe(MAX_WEBPAGE_OUTPUT_BYTES);
    expect(save).not.toHaveBeenCalled();
  });

  it.each([
    "normal",
    "auto",
  ] as const)("lets %s mode grep beyond 200 KiB, read, list and fuzzy-search the same saved snapshot without approval", async (mode) => {
    mocks.mode = mode;
    const markdown = `${"A paragraph with ordinary text.\n".repeat(12000)}TAIL_NEEDLE\n`;
    mocks.readWebpage.mockResolvedValue({ ...page, markdown });
    const output = String(await ReadWebpageTool.handler({ url: page.url }));
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(MAX_WEBPAGE_OUTPUT_BYTES);
    expect(output).toContain("Output truncated: yes");
    expect(output).not.toContain("TAIL_NEEDLE");
    const file = savedPath(output);
    expect(path.basename(path.dirname(file))).toBe(workspaceBucket(getWorkspaceRoot()));
    expect(path.basename(path.dirname(path.dirname(file)))).toBe("evil-jelly");
    expect(path.basename(file)).toMatch(/^Page-[0-9a-f-]+\.md$/);
    expect(await fs.readFile(file, "utf8")).toBe(markdown);
    expect((await fs.stat(file)).size).toBeGreaterThan(200 * 1024);

    const grep = await executeGrepSearch("TAIL_NEEDLE", undefined, 1, { directory: file });
    expect(grep).toContain("> 12001 | TAIL_NEEDLE");
    const read = String(
      await ReadFileTool.handler({ filePaths: [{ path: file, offset: 12001, limit: 1 }] }),
    );
    expect(read).toContain("TAIL_NEEDLE");
    const root = path.dirname(file);
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
    expect(mocks.confirmTool).not.toHaveBeenCalled();
  });

  it("wraps pathological Unicode lines losslessly into readable snapshot lines", async () => {
    const markdown = "界😀".repeat(20000);
    mocks.readWebpage.mockResolvedValue({ ...page, markdown });
    const output = String(await ReadWebpageTool.handler({ url: page.url }));
    const file = savedPath(output);
    const text = await fs.readFile(file, "utf8");
    expect(text.replace(/\n/g, "")).toBe(markdown);
    expect(output).toContain("Long lines wrapped for reading: yes");
    expect(output).not.toContain("�");
    for (const line of text.split("\n"))
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(8192);
    const read = String(
      await ReadFileTool.handler({ filePaths: [{ path: file, offset: 1, limit: 1 }] }),
    );
    expect(read).toContain("界😀");
    expect(read).not.toContain("Error:");
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(MAX_WEBPAGE_OUTPUT_BYTES);
  });

  it("reports incomplete source fetching separately from output truncation", async () => {
    mocks.readWebpage.mockResolvedValue({
      ...page,
      markdown: "line\n".repeat(15000),
      truncated: true,
    });
    const output = String(await ReadWebpageTool.handler({ url: page.url }));
    expect(output).toContain("Source fetch truncated: yes (the source was not fully fetched)");
    expect(output).toContain("Output truncated: yes");
    expect(savedPath(output)).toBeTruthy();
  });

  it("bounds save failures without claiming that omitted content is available", async () => {
    vi.spyOn(toolArtifacts, "saveText").mockRejectedValue(new Error("disk failure ".repeat(20000)));
    mocks.readWebpage.mockResolvedValue({ ...page, markdown: "text\n".repeat(15000) });
    const output = String(await ReadWebpageTool.handler({ url: page.url }));
    expect(output).toContain("Snapshot save failed:");
    expect(output).toContain("omitted content was not saved");
    expect(output).not.toContain("Saved Markdown:");
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(MAX_WEBPAGE_OUTPUT_BYTES);
  });

  it("bounds metadata, empty-page messages and fetch errors too", async () => {
    mocks.readWebpage.mockResolvedValue({
      ...page,
      title: "界😀".repeat(20000),
      url: `https://example.test/${"x".repeat(50000)}`,
      markdown: "body\n".repeat(10000),
    });
    const output = String(await ReadWebpageTool.handler({ url: page.url }));
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(MAX_WEBPAGE_OUTPUT_BYTES);
    expect(output).not.toContain("�");
    mocks.readWebpage.mockResolvedValue({ ...page, url: "界".repeat(50000), markdown: "" });
    const empty = String(await ReadWebpageTool.handler({ url: page.url }));
    expect(empty).toContain("empty body");
    expect(Buffer.byteLength(empty, "utf8")).toBeLessThanOrEqual(MAX_WEBPAGE_OUTPUT_BYTES);
    mocks.readWebpage.mockRejectedValue(new Error("界😀".repeat(50000)));
    const failed = String(await ReadWebpageTool.handler({ url: page.url }));
    expect(failed).toContain("read_webpage failed:");
    expect(Buffer.byteLength(failed, "utf8")).toBeLessThanOrEqual(MAX_WEBPAGE_OUTPUT_BYTES);
    expect(failed).not.toContain("�");
  });
});
