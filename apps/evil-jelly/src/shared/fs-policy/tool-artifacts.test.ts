import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workspaceBucket } from "../workspaceBucket";
import {
  MAX_TOOL_ARTIFACT_BYTES,
  MAX_TOOL_ARTIFACT_FILES,
  MAX_TOOL_ARTIFACT_TOTAL_BYTES,
  TOOL_ARTIFACT_TTL_MS,
  ToolArtifactStore,
} from "./tool-artifacts";
import { getWorkspaceRoot, setWorkspaceRoot } from "./workspace-context";

const stores: ToolArtifactStore[] = [];
function createStore(
  workspace = path.join(os.tmpdir(), `evil-artifact-test-workspace-${randomUUID()}`),
): ToolArtifactStore {
  const store = new ToolArtifactStore(workspace);
  stores.push(store);
  return store;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.dispose();
});

describe("ToolArtifactStore", () => {
  it("creates a private registered directory in system temp, not a temp-wide grant", async () => {
    const store = createStore();
    const file = await store.saveText("# saved Markdown\n");
    const root = path.dirname(file);
    expect(path.basename(root)).toMatch(/^evil-artifact-test-workspace-[0-9a-f-]+-[0-9a-f]{8}$/);
    expect(path.dirname(root).toLowerCase()).toBe(
      path.join(await fs.realpath(os.tmpdir()), "evil-jelly").toLowerCase(),
    );
    expect(await fs.readFile(file, "utf8")).toBe("# saved Markdown\n");
    expect(store.canRead(file)).toBe(true);
    expect(store.canRead(root)).toBe(true);
    expect(store.canRead(os.tmpdir())).toBe(false);
    expect(store.canRead(`${root}-lookalike/file.md`)).toBe(false);
    expect(store.canRead(path.join(root, "..", "unrelated.md"))).toBe(false);
    expect(createStore().canRead(file)).toBe(false);
  });

  it("uses stable session-compatible buckets with query-random filenames", async () => {
    const workspace = path.join(os.tmpdir(), `stable-artifact-workspace-${randomUUID()}`);
    const first = createStore(workspace);
    const second = createStore(workspace);
    const a = await first.saveText("first", "Report / query?*");
    const b = await second.saveText("second", "Report / query?*");
    expect(path.dirname(a)).toBe(path.dirname(b));
    expect(path.basename(path.dirname(a))).toBe(workspaceBucket(workspace));
    expect(path.basename(a)).toMatch(/^Report-query-[0-9a-f-]+\.md$/);
    expect(a).not.toBe(b);
    expect(first.canRead(b)).toBe(true);
    first.dispose();
    expect(await fs.readFile(b, "utf8")).toBe("second");
  });

  it("captures project identity before queued writes and does not grant access across projects", async () => {
    const store = new ToolArtifactStore();
    stores.push(store);
    const previous = getWorkspaceRoot();
    const a = path.join(os.tmpdir(), `workspace-a-${randomUUID()}`);
    const b = path.join(os.tmpdir(), `workspace-b-${randomUUID()}`);
    try {
      setWorkspaceRoot(a);
      const savingA = store.saveText("A", "query");
      setWorkspaceRoot(b);
      const savingB = store.saveText("B", "query");
      const [fileA, fileB] = await Promise.all([savingA, savingB]);
      expect(path.basename(path.dirname(fileA))).toBe(workspaceBucket(a));
      expect(path.basename(path.dirname(fileB))).toBe(workspaceBucket(b));
      expect(store.canRead(fileA)).toBe(false);
      expect(store.canRead(fileB)).toBe(true);
      expect(store.canRead(fileA, a)).toBe(true);
      expect(store.canRead(fileA, b)).toBe(false);
      setWorkspaceRoot(a);
      expect(store.canRead(fileA)).toBe(true);
      expect(store.canRead(fileB)).toBe(false);
    } finally {
      setWorkspaceRoot(previous);
    }
  });

  it("does not follow a junction outside the owned root", async () => {
    const store = createStore();
    const other = createStore();
    const file = await store.saveText("owned");
    const otherFile = await other.saveText("other");
    const link = path.join(path.dirname(file), "escape");
    await fs.symlink(path.dirname(otherFile), link, "junction");
    try {
      expect(store.canRead(path.join(link, path.basename(otherFile)))).toBe(false);
      expect(store.canRead(path.join(link, "missing.md"))).toBe(false);
    } finally {
      await fs.unlink(link);
    }
  });

  it("rejects replacement of the registered root and never cleans through that junction", async () => {
    const store = createStore();
    const other = createStore();
    const file = await store.saveText("owned");
    const otherFile = await other.saveText("other");
    const root = path.dirname(file);
    const moved = `${root}-moved`;
    const sentinel = path.join(path.dirname(otherFile), path.basename(file));
    await fs.writeFile(sentinel, "do not delete");
    await fs.rename(root, moved);
    await fs.symlink(path.dirname(otherFile), root, "junction");
    try {
      expect(store.canRead(root)).toBe(false);
      store.dispose();
      expect(await fs.readFile(sentinel, "utf8")).toBe("do not delete");
    } finally {
      await fs.unlink(root);
      await fs.rename(moved, root);
      await fs.unlink(sentinel);
    }
  });

  it("serializes parallel saves and evicts oldest snapshots at the file-count cap", async () => {
    const store = createStore();
    const files = await Promise.all(
      Array.from({ length: MAX_TOOL_ARTIFACT_FILES + 1 }, (_, i) => store.saveText(`page ${i}`)),
    );
    await expect(fs.stat(files[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(path.dirname(files.at(-1)!))).toHaveLength(MAX_TOOL_ARTIFACT_FILES);
    expect(await fs.readFile(files.at(-1)!, "utf8")).toBe(`page ${MAX_TOOL_ARTIFACT_FILES}`);
  });

  it("bounds individual and total bytes", async () => {
    const store = createStore();
    await expect(store.saveText("x".repeat(MAX_TOOL_ARTIFACT_BYTES + 1))).rejects.toThrow(
      "file limit",
    );
    const content = "x".repeat(MAX_TOOL_ARTIFACT_BYTES);
    const count = MAX_TOOL_ARTIFACT_TOTAL_BYTES / MAX_TOOL_ARTIFACT_BYTES;
    const files: string[] = [];
    for (let i = 0; i <= count; i++) files.push(await store.saveText(content));
    await expect(fs.stat(files[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(path.dirname(files.at(-1)!))).toHaveLength(count);
  });

  it("expires snapshots lazily but lets file tools report a missing file without a new approval", async () => {
    const store = createStore();
    const file = await store.saveText("expired");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + TOOL_ARTIFACT_TTL_MS);
    expect(store.canRead(file)).toBe(true);
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recreates the same project directory if the OS removes it", async () => {
    const store = createStore();
    const first = await store.saveText("first");
    await fs.unlink(first);
    await fs.rmdir(path.dirname(first));
    const second = await store.saveText("second");
    expect(path.dirname(second)).toBe(path.dirname(first));
    expect(await fs.readFile(second, "utf8")).toBe("second");
  });

  it("cleans only registered files and leaves unrelated contents alone", async () => {
    const store = createStore();
    const file = await store.saveText("owned");
    const extra = path.join(path.dirname(file), "not-registered.txt");
    await fs.writeFile(extra, "preserve");
    try {
      store.dispose();
      await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(extra, "utf8")).toBe("preserve");
    } finally {
      await fs.unlink(extra);
    }
  });
});
