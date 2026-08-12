import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initSettings } from "../../../../shared/configuration/settings";
import {
  getWorkspaceFsPolicy,
  setWorkspaceRoot,
} from "../../../../shared/fs-policy/workspace-fs-policy";
import { parseDocMap, resolveDocMapEntries, resolveSyncPairs } from "./docmap";

describe("parseDocMap", () => {
  it("parses a valid map with comments", () => {
    const raw = `{
  // seed map
  "version": 1,
  "docs": {
    "docs/api/core.md": { "paths": ["packages/core/src/core"] },
    "docs/api/old.md": { "skip": "retired" }
  }
}`;
    const map = parseDocMap(raw, "doc-map.jsonc");
    expect(map.sync).toBeUndefined();
    expect(map.docs["docs/api/core.md"].paths).toEqual(["packages/core/src/core"]);
    expect(map.docs["docs/api/old.md"].skip).toBe("retired");
  });

  it("parses sync pairs when present", () => {
    const map = parseDocMap(
      `{
        "version": 1,
        "sync": { "pairs": [["docs/zh/**/*.md", "docs/en/**/*.md"]] },
        "docs": {}
      }`,
      "doc-map.jsonc",
    );
    expect(map.sync?.pairs).toEqual([["docs/zh/**/*.md", "docs/en/**/*.md"]]);
  });

  it("allows path/glob keys", () => {
    const map = parseDocMap(
      `{
        "version": 1,
        "docs": { "packages/*/README.md": { "paths": ["$dir/src"] } }
      }`,
      "doc-map.jsonc",
    );
    expect(map.docs["packages/*/README.md"].paths).toEqual(["$dir/src"]);
  });

  it("throws a clear error on invalid JSON", () => {
    expect(() => parseDocMap("{ nope", "doc-map.jsonc")).toThrow(/not valid JSON/);
  });

  it("throws a clear error on schema violations", () => {
    expect(() => parseDocMap(`{ "version": 2, "docs": {} }`, "m.jsonc")).toThrow(
      /failed validation/,
    );
    expect(() =>
      parseDocMap(`{ "version": 1, "docs": { "a.md": { "unknown": true } } }`, "m.jsonc"),
    ).toThrow(/failed validation/);
  });

  it("rejects the removed roots key", () => {
    expect(() =>
      parseDocMap(
        `{ "version": 1, "roots": { "primary": "docs/zh", "mirror": "docs/en" }, "docs": {} }`,
        "m.jsonc",
      ),
    ).toThrow(/failed validation/);
  });

  it("rejects sync pairs with mismatched wildcard shapes", () => {
    expect(() =>
      parseDocMap(
        `{ "version": 1, "sync": { "pairs": [["docs/zh/**/*.md", "docs/en/*.md"]] }, "docs": {} }`,
        "m.jsonc",
      ),
    ).toThrow(/wildcard shape mismatch/);
  });

  it("rejects the removed docsDir field", () => {
    expect(() =>
      parseDocMap(
        `{ "version": 1, "docsDir": "docs/api", "docs": { "docs/api/core.md": { "paths": ["src"] } } }`,
        "m.jsonc",
      ),
    ).toThrow(/failed validation/);
  });
});

describe("resolveDocMapEntries", () => {
  let prevRoot: string;
  let dir: string;

  beforeEach(() => {
    prevRoot = getWorkspaceFsPolicy().getRoot();
    dir = mkdtempSync(join(tmpdir(), "evil-jelly-docmap-"));
    setWorkspaceRoot(dir);
    initSettings({});
  });

  afterEach(() => {
    setWorkspaceRoot(prevRoot);
    initSettings({});
    rmSync(dir, { recursive: true, force: true });
  });

  function write(rel: string, content = ""): void {
    const file = join(dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  it("treats keys without slashes as literal workspace-root paths", async () => {
    write("docs/api/core.md");
    const map = parseDocMap(
      `{ "version": 1, "docs": { "core.md": { "paths": ["src"] } } }`,
      "doc-map.jsonc",
    );
    await expect(resolveDocMapEntries(map)).resolves.toEqual([
      { docFile: "core.md", entry: { paths: ["src"] } },
    ]);
  });

  it("expands $dir per matched glob doc", async () => {
    write("packages/a/README.md");
    write("packages/b/README.md");
    const map = parseDocMap(
      `{
        "version": 1,
        "docs": {
          "packages/*/README.md": { "paths": ["$dir/src"] }
        }
      }`,
      "doc-map.jsonc",
    );
    await expect(resolveDocMapEntries(map)).resolves.toEqual([
      { docFile: "packages/a/README.md", entry: { paths: ["packages/a/src"] } },
      { docFile: "packages/b/README.md", entry: { paths: ["packages/b/src"] } },
    ]);
  });

  it("lets explicit path keys override glob matches when written after the glob", async () => {
    write("packages/a/README.md");
    const map = parseDocMap(
      `{
        "version": 1,
        "docs": {
          "packages/*/README.md": { "paths": ["$dir/src"] },
          "packages/a/README.md": { "paths": ["packages/a/lib"], "note": "override" }
        }
      }`,
      "doc-map.jsonc",
    );
    await expect(resolveDocMapEntries(map)).resolves.toEqual([
      {
        docFile: "packages/a/README.md",
        entry: { paths: ["packages/a/lib"], note: "override" },
      },
    ]);
  });

  it("lets explicit path keys override glob matches when written before the glob", async () => {
    write("packages/a/README.md");
    const map = parseDocMap(
      `{
        "version": 1,
        "docs": {
          "packages/a/README.md": { "paths": ["packages/a/lib"], "note": "override" },
          "packages/*/README.md": { "paths": ["$dir/src"] }
        }
      }`,
      "doc-map.jsonc",
    );
    await expect(resolveDocMapEntries(map)).resolves.toEqual([
      {
        docFile: "packages/a/README.md",
        entry: { paths: ["packages/a/lib"], note: "override" },
      },
    ]);
  });

  it("lets later glob matches override earlier glob matches", async () => {
    write("packages/a/README.md");
    const map = parseDocMap(
      `{
        "version": 1,
        "docs": {
          "packages/*/README.md": { "paths": ["$dir/src"] },
          "packages/a/*.md": { "paths": ["packages/a/lib"], "note": "later glob" }
        }
      }`,
      "doc-map.jsonc",
    );
    await expect(resolveDocMapEntries(map)).resolves.toEqual([
      {
        docFile: "packages/a/README.md",
        entry: { paths: ["packages/a/lib"], note: "later glob" },
      },
    ]);
  });
});

describe("resolveSyncPairs", () => {
  let prevRoot: string;
  let dir: string;

  beforeEach(() => {
    prevRoot = getWorkspaceFsPolicy().getRoot();
    dir = mkdtempSync(join(tmpdir(), "evil-jelly-syncpairs-"));
    setWorkspaceRoot(dir);
    initSettings({});
    vi.restoreAllMocks();
  });

  afterEach(() => {
    setWorkspaceRoot(prevRoot);
    initSettings({});
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function write(rel: string, content = ""): void {
    const file = join(dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  it("expands mirrored tree pairs from left files", async () => {
    write("docs/zh/api/core.md");
    const map = parseDocMap(
      `{ "version": 1, "sync": { "pairs": [["docs/zh/**/*.md", "docs/en/**/*.md"]] }, "docs": {} }`,
      "doc-map.jsonc",
    );
    await expect(resolveSyncPairs(map)).resolves.toEqual([
      { leftFile: "docs/zh/api/core.md", rightFile: "docs/en/api/core.md" },
    ]);
  });

  it("expands same-directory suffix pairs", async () => {
    write("examples/01-basics/chat-agent/README.zh-CN.md");
    write("examples/01-basics/chat-agent/README.md");
    const map = parseDocMap(
      `{ "version": 1, "sync": { "pairs": [["examples/**/README.zh-CN.md", "examples/**/README.md"]] }, "docs": {} }`,
      "doc-map.jsonc",
    );
    await expect(resolveSyncPairs(map)).resolves.toEqual([
      {
        leftFile: "examples/01-basics/chat-agent/README.zh-CN.md",
        rightFile: "examples/01-basics/chat-agent/README.md",
      },
    ]);
  });

  it("includes left-only and right-only files", async () => {
    write("docs/zh/only-left.md");
    write("docs/en/only-right.md");
    const map = parseDocMap(
      `{ "version": 1, "sync": { "pairs": [["docs/zh/*.md", "docs/en/*.md"]] }, "docs": {} }`,
      "doc-map.jsonc",
    );
    await expect(resolveSyncPairs(map)).resolves.toEqual([
      { leftFile: "docs/zh/only-left.md", rightFile: "docs/en/only-left.md" },
      { leftFile: "docs/zh/only-right.md", rightFile: "docs/en/only-right.md" },
    ]);
  });

  it("deduplicates the bidirectional union", async () => {
    write("docs/zh/core.md");
    write("docs/en/core.md");
    const map = parseDocMap(
      `{ "version": 1, "sync": { "pairs": [["docs/zh/*.md", "docs/en/*.md"]] }, "docs": {} }`,
      "doc-map.jsonc",
    );
    await expect(resolveSyncPairs(map)).resolves.toEqual([
      { leftFile: "docs/zh/core.md", rightFile: "docs/en/core.md" },
    ]);
  });

  it("allows ** to capture an empty directory segment", async () => {
    write("docs/zh/index.md");
    const map = parseDocMap(
      `{ "version": 1, "sync": { "pairs": [["docs/zh/**/*.md", "docs/en/**/*.md"]] }, "docs": {} }`,
      "doc-map.jsonc",
    );
    await expect(resolveSyncPairs(map)).resolves.toEqual([
      { leftFile: "docs/zh/index.md", rightFile: "docs/en/index.md" },
    ]);
  });

  it("warns when a pair rule matches nothing on both sides", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const map = parseDocMap(
      `{ "version": 1, "sync": { "pairs": [["missing/zh/*.md", "missing/en/*.md"]] }, "docs": {} }`,
      "doc-map.jsonc",
    );
    await expect(resolveSyncPairs(map)).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "Doc sync pair matched no files: missing/zh/*.md ⇄ missing/en/*.md",
    );
  });
});
