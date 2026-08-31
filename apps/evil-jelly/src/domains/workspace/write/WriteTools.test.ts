import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setWorkspaceRoot } from "../../../shared/fs-policy/workspace-context";
import type { EvilJellyBindings } from "../../../shared/host/bindings";
import type {
  FsOutsideAccessPayload,
  FsWritePayload,
} from "../../../shared/host/toolConfirmationBindings";
import { createTestHostBindings } from "../__tests__/testHostBindings";
import { createCreateFileTool, createDeleteFileTool, createEditFileTool } from "./WriteTools";

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

function createTempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "evil-jelly-write-tools-"));
}

afterEach(() => {
  hostBindingMock.current = null;
});

describe("createEditFileTool", () => {
  it("edits an exact gitignored file through the normal diff confirmation", async () => {
    const dir = createTempWorkspace();
    try {
      mkdirSync(join(dir, "local"), { recursive: true });
      writeFileSync(join(dir, ".gitignore"), "local/\n", "utf8");
      writeFileSync(join(dir, "local/settings.json"), '{"enabled":false}\n', "utf8");
      setWorkspaceRoot(dir);

      const seen: FsWritePayload[] = [];
      const tool = createEditFileTool(async (params) => {
        if (params.type !== "fs_write") {
          throw new Error(`Unexpected payload type: ${params.type}`);
        }
        seen.push(params);
        return { action: "accept" };
      });

      const result = await tool.handler({
        targets: [
          {
            filePath: "local/settings.json",
            edits: [{ searchBlock: "false", replaceBlock: "true" }],
          },
        ],
      });

      expect(result).toBe(`Updated ${join("local", "settings.json")} (1 edit(s)).`);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.unifiedDiff).toContain("settings.json");
      expect(await readFile(join(dir, "local/settings.json"), "utf8")).toBe('{"enabled":true}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps dependency files read-only", async () => {
    const dir = createTempWorkspace();
    try {
      mkdirSync(join(dir, "node_modules/pkg"), { recursive: true });
      writeFileSync(join(dir, "node_modules/pkg/index.js"), "export const value = 1;\n", "utf8");
      setWorkspaceRoot(dir);

      let confirmed = false;
      const tool = createEditFileTool(async () => {
        confirmed = true;
        return { action: "accept" };
      });
      const result = await tool.handler({
        targets: [
          {
            filePath: "node_modules/pkg/index.js",
            edits: [{ searchBlock: "1", replaceBlock: "2" }],
          },
        ],
      });

      expect(result).toContain("hidden or ignored");
      expect(confirmed).toBe(false);
      expect(await readFile(join(dir, "node_modules/pkg/index.js"), "utf8")).toContain("1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supports single-file edit via one-item targets array", async () => {
    const dir = createTempWorkspace();
    try {
      const filePath = "a.ts";
      writeFileSync(join(dir, filePath), "const value = 1\n", "utf8");
      setWorkspaceRoot(dir);

      const seen: FsWritePayload[] = [];
      const tool = createEditFileTool(async (params) => {
        if (params.type !== "fs_write") {
          throw new Error(`Unexpected payload type: ${params.type}`);
        }
        seen.push(params);
        return { action: "accept" };
      });

      const result = await tool.handler({
        targets: [{ filePath, edits: [{ searchBlock: "1", replaceBlock: "2" }] }],
      });

      expect(result).toBe("Updated a.ts (1 edit(s)).");
      expect(seen).toHaveLength(1);
      expect(seen[0]?.filePath).toBe("a.ts");
      expect(seen[0]?.supportedActions).toEqual(["accept", "reject", "edit", "retry"]);
      expect(await readFile(join(dir, filePath), "utf8")).toBe("const value = 2\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies batch edits across files with one confirmation", async () => {
    const dir = createTempWorkspace();
    try {
      writeFileSync(join(dir, "a.ts"), "const a = 1\n", "utf8");
      writeFileSync(join(dir, "b.ts"), "const b = 10\n", "utf8");
      setWorkspaceRoot(dir);

      const seen: FsWritePayload[] = [];
      const tool = createEditFileTool(async (params) => {
        if (params.type !== "fs_write") {
          throw new Error(`Unexpected payload type: ${params.type}`);
        }
        seen.push(params);
        return { action: "accept" };
      });

      const result = await tool.handler({
        targets: [
          { filePath: "a.ts", edits: [{ searchBlock: "1", replaceBlock: "2" }] },
          { filePath: "b.ts", edits: [{ searchBlock: "10", replaceBlock: "20" }] },
        ],
      });

      expect(result).toBe("Updated 2 files (2 edit(s) total).");
      expect(seen).toHaveLength(1);
      expect(seen[0]?.filePath).toBe("2 files");
      expect(seen[0]?.reviewCaption).toBe("Batch edit across 2 files");
      expect(seen[0]?.supportedActions).toEqual(["accept", "reject", "retry"]);
      expect(seen[0]?.unifiedDiff).toContain("--- a.ts");
      expect(seen[0]?.unifiedDiff).toContain("--- b.ts");

      expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("const a = 2\n");
      expect(await readFile(join(dir, "b.ts"), "utf8")).toBe("const b = 20\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merges edits for a repeated filePath into one confirmed write", async () => {
    const dir = createTempWorkspace();
    try {
      writeFileSync(join(dir, "a.ts"), "const a = 1\nconst b = 2\n", "utf8");
      setWorkspaceRoot(dir);

      const seen: FsWritePayload[] = [];
      const tool = createEditFileTool(async (params) => {
        if (params.type !== "fs_write") {
          throw new Error(`Unexpected payload type: ${params.type}`);
        }
        seen.push(params);
        return { action: "accept" };
      });

      const result = await tool.handler({
        targets: [
          {
            filePath: "a.ts",
            edits: [{ searchBlock: "const a = 1", replaceBlock: "const a = 10" }],
          },
          {
            filePath: "a.ts",
            edits: [{ searchBlock: "const b = 2", replaceBlock: "const b = 20" }],
          },
        ],
      });

      // Same-path targets collapse to a single (non-batch) edit covering both sites.
      expect(result).toBe("Updated a.ts (2 edit(s)).");
      expect(seen).toHaveLength(1);
      expect(seen[0]?.filePath).toBe("a.ts");
      expect(seen[0]?.supportedActions).toEqual(["accept", "reject", "edit", "retry"]);
      expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("const a = 10\nconst b = 20\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records the content actually written after host-side editing", async () => {
    const dir = createTempWorkspace();
    try {
      writeFileSync(join(dir, "a.ts"), "const value = 1\n", "utf8");
      setWorkspaceRoot(dir);
      const recordAppliedDiff = vi.fn();
      const tool = createEditFileTool(
        async () => ({ action: "edit", modifiedContent: "const value = 3\n" }),
        { recordAppliedDiff },
      );

      await tool.handler({
        targets: [{ filePath: "a.ts", edits: [{ searchBlock: "1", replaceBlock: "2" }] }],
      });

      expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("const value = 3\n");
      expect(recordAppliedDiff).toHaveBeenCalledOnce();
      expect(recordAppliedDiff.mock.calls[0]?.[0].text).toContain("+const value = 3");
      expect(recordAppliedDiff.mock.calls[0]?.[0].text).not.toContain("+const value = 2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns retry feedback for batch and keeps files unchanged", async () => {
    const dir = createTempWorkspace();
    try {
      writeFileSync(join(dir, "a.ts"), "const a = 1\n", "utf8");
      writeFileSync(join(dir, "b.ts"), "const b = 10\n", "utf8");
      setWorkspaceRoot(dir);

      const tool = createEditFileTool(async () => ({
        action: "retry",
        feedback: "please split this into smaller edits",
      }));

      const result = await tool.handler({
        targets: [
          { filePath: "a.ts", edits: [{ searchBlock: "1", replaceBlock: "2" }] },
          { filePath: "b.ts", edits: [{ searchBlock: "10", replaceBlock: "20" }] },
        ],
      });

      expect(result).toBe(
        "User asked to retry with feedback: please split this into smaller edits",
      );
      expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("const a = 1\n");
      expect(await readFile(join(dir, "b.ts"), "utf8")).toBe("const b = 10\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createDeleteFileTool", () => {
  it("deletes existing targets and treats missing targets as non-fatal warnings", async () => {
    const dir = createTempWorkspace();
    try {
      writeFileSync(join(dir, "a.ts"), "const a = 1\n", "utf8");
      setWorkspaceRoot(dir);

      const seen: FsWritePayload[] = [];
      const recordAppliedDiff = vi.fn();
      const tool = createDeleteFileTool(
        async (params) => {
          if (params.type !== "fs_write") {
            throw new Error(`Unexpected payload type: ${params.type}`);
          }
          seen.push(params);
          return { action: "accept" };
        },
        { recordAppliedDiff },
      );

      const result = await tool.handler({
        targetPaths: ["a.ts", "already-gone.ts"],
      });

      expect(result).toContain("Deleted 1 target(s).");
      expect(result).toContain("File already deleted: already-gone.ts");
      expect(seen).toHaveLength(1);
      expect(seen[0]?.kind).toBe("delete");
      expect(seen[0]?.supportedActions).toEqual(["accept", "reject", "retry"]);
      expect(existsSync(join(dir, "a.ts"))).toBe(false);
      expect(recordAppliedDiff.mock.calls[0]?.[0].text).toContain("-const a = 1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recursively prunes empty parent directories after deleting a file", async () => {
    const dir = createTempWorkspace();
    try {
      mkdirSync(join(dir, "ghost/nested"), { recursive: true });
      writeFileSync(join(dir, "ghost/nested/unused.ts"), "export {}\n", "utf8");
      writeFileSync(join(dir, "keep.ts"), "export const keep = true\n", "utf8");
      setWorkspaceRoot(dir);

      const tool = createDeleteFileTool(async () => ({ action: "accept" }));
      const result = await tool.handler({
        targetPaths: ["ghost/nested/unused.ts"],
      });

      expect(result).toContain("Deleted 1 target(s).");
      expect(result).toContain("Cleaned 2 empty parent directories.");
      expect(existsSync(join(dir, "ghost/nested/unused.ts"))).toBe(false);
      expect(existsSync(join(dir, "ghost/nested"))).toBe(false);
      expect(existsSync(join(dir, "ghost"))).toBe(false);
      expect(existsSync(join(dir, "keep.ts"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires outside access and delete diff confirmation for an outside target", async () => {
    const dir = createTempWorkspace();
    const outsideDir = mkdtempSync(join(tmpdir(), "evil-jelly-outside-delete-"));
    const outsideFile = join(outsideDir, "obsolete.ts");
    try {
      writeFileSync(outsideFile, "export const obsolete = true\n", "utf8");
      setWorkspaceRoot(dir);
      const outsideAccessRequests: FsOutsideAccessPayload[] = [];
      hostBindingMock.current = createTestHostBindings({
        mode: "normal",
        outsideAccessRequests,
      });
      const seenWrites: FsWritePayload[] = [];
      const tool = createDeleteFileTool(async (params) => {
        if (params.type !== "fs_write") {
          throw new Error(`Unexpected payload type: ${params.type}`);
        }
        seenWrites.push(params);
        return { action: "accept" };
      });

      const result = await tool.handler({ targetPaths: [outsideFile] });

      expect(result).toContain("Deleted 1 target(s).");
      expect(outsideAccessRequests).toHaveLength(1);
      expect(outsideAccessRequests[0]?.access).toBe("write");
      expect(seenWrites).toHaveLength(1);
      expect(seenWrites[0]?.kind).toBe("delete");
      expect(existsSync(outsideFile)).toBe(false);
      expect(existsSync(outsideDir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe("createCreateFileTool", () => {
  it("creates multiple files in a single batch", async () => {
    const dir = createTempWorkspace();
    try {
      setWorkspaceRoot(dir);

      const seen: FsWritePayload[] = [];
      const recordAppliedDiff = vi.fn();
      const tool = createCreateFileTool(
        async (params) => {
          if (params.type !== "fs_write") {
            throw new Error(`Unexpected payload type: ${params.type}`);
          }
          seen.push(params);
          return { action: "accept" };
        },
        { recordAppliedDiff },
      );

      const result = await tool.handler({
        targets: [
          { filePath: "c.ts", content: "const c = 3" },
          { filePath: "d.ts", content: "const d = 4" },
        ],
      });

      expect(result).toBe("Created 2 files.");
      expect(seen).toHaveLength(1);
      expect(seen[0]?.filePath).toBe("2 files");
      expect(seen[0]?.reviewCaption).toBe("Batch create 2 files");
      expect(seen[0]?.supportedActions).toEqual(["accept", "reject", "retry"]);

      expect(await readFile(join(dir, "c.ts"), "utf8")).toBe("const c = 3");
      expect(await readFile(join(dir, "d.ts"), "utf8")).toBe("const d = 4");
      expect(recordAppliedDiff).toHaveBeenCalledTimes(2);
      expect(recordAppliedDiff.mock.calls.at(-1)?.[0].text).toContain("+const d = 4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires outside access confirmation before outside create diff review", async () => {
    const dir = createTempWorkspace();
    const outsideDir = mkdtempSync(join(tmpdir(), "evil-jelly-outside-create-"));
    try {
      setWorkspaceRoot(dir);
      const outsideFile = join(outsideDir, "created.ts");
      const outsideAccessRequests: FsOutsideAccessPayload[] = [];
      hostBindingMock.current = createTestHostBindings({ mode: "auto", outsideAccessRequests });

      const seenWrites: FsWritePayload[] = [];
      const tool = createCreateFileTool(async (params) => {
        if (params.type !== "fs_write") {
          throw new Error(`Unexpected payload type: ${params.type}`);
        }
        seenWrites.push(params);
        return { action: "accept" };
      });

      const result = await tool.handler({
        targets: [{ filePath: outsideFile, content: "export const outside = true\n" }],
      });

      expect(result).toBe(`Created ${outsideFile}.`);
      expect(outsideAccessRequests).toHaveLength(1);
      expect(outsideAccessRequests[0]?.access).toBe("write");
      expect(seenWrites).toHaveLength(1);
      expect(seenWrites[0]?.outsideWorkspace).toBe(true);
      expect(await readFile(outsideFile, "utf8")).toBe("export const outside = true\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("fails if any file already exists", async () => {
    const dir = createTempWorkspace();
    try {
      writeFileSync(join(dir, "e.ts"), "const e = 5\n", "utf8");
      setWorkspaceRoot(dir);

      const tool = createCreateFileTool(async () => ({ action: "accept" }));

      const result = await tool.handler({
        targets: [
          { filePath: "f.ts", content: "const f = 6" },
          { filePath: "e.ts", content: "const e = 50" },
        ],
      });

      expect(result).toContain("already exists");
      expect(existsSync(join(dir, "f.ts"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate targets that resolve to the same workspace path", async () => {
    const dir = createTempWorkspace();
    try {
      setWorkspaceRoot(dir);

      let confirmed = false;
      const tool = createCreateFileTool(async () => {
        confirmed = true;
        return { action: "accept" };
      });

      const result = await tool.handler({
        targets: [
          { filePath: "src/../same.ts", content: "first" },
          { filePath: "same.ts", content: "second" },
        ],
      });

      expect(result).toContain("Duplicate filePath in batch");
      expect(confirmed).toBe(false);
      expect(existsSync(join(dir, "same.ts"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not overwrite a file created after confirmation preview", async () => {
    const dir = createTempWorkspace();
    try {
      setWorkspaceRoot(dir);

      const tool = createCreateFileTool(async () => {
        writeFileSync(join(dir, "race.ts"), "created elsewhere", "utf8");
        return { action: "accept" };
      });

      const result = await tool.handler({
        targets: [{ filePath: "race.ts", content: "agent content" }],
      });

      expect(result).toContain("already exists");
      expect(await readFile(join(dir, "race.ts"), "utf8")).toBe("created elsewhere");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
