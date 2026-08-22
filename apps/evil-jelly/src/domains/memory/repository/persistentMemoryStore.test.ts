import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryFixtureEntry } from "../__tests__/memoryTestFixtures";
import { PersistentMemoryStore, PersistentMemoryStoreError } from "./persistentMemoryStore";

const temporaryRoots: string[] = [];

async function createStore(): Promise<PersistentMemoryStore> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "evil-memory-workspace-"));
  const memoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evil-memory-root-"));
  temporaryRoots.push(workspace, memoryRoot);
  return new PersistentMemoryStore({ workspaceRoot: workspace, memoryRoot });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("persistent memory store", () => {
  it("starts from missing files and writes sorted entries atomically", async () => {
    const store = await createStore();
    expect((await store.read("project")).entries).toEqual([]);
    const later = createMemoryFixtureEntry({
      id: "mem_00000000-0000-4000-8000-000000000002",
      detail: "Second independent memory detail.",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    const first = createMemoryFixtureEntry({ createdAt: "2026-01-01T00:00:00.000Z" });
    await store.mutate("project", ({ current }) => ({
      file: { version: 1, entries: [later, ...current.entries, first] },
      value: undefined,
    }));
    expect((await store.read("project")).entries.map((entry) => entry.id)).toEqual([
      first.id,
      later.id,
    ]);
    expect((await fs.readFile(store.filePath("project"), "utf8")).endsWith("\n")).toBe(true);
  });

  it("fails closed for malformed, unknown-version, and wrong-scope files", async () => {
    const store = await createStore();
    await fs.mkdir(path.dirname(store.filePath("project")), { recursive: true });
    await fs.writeFile(store.filePath("project"), "{not-json", "utf8");
    await expect(store.read("project")).rejects.toMatchObject({ code: "unavailable" });
    await fs.writeFile(
      store.filePath("project"),
      JSON.stringify({ version: 2, entries: [] }),
      "utf8",
    );
    await expect(store.read("project")).rejects.toBeInstanceOf(PersistentMemoryStoreError);
  });

  it("does not lose concurrent read-modify-write updates", async () => {
    const store = await createStore();
    const entries = [
      createMemoryFixtureEntry(),
      createMemoryFixtureEntry({
        id: "mem_00000000-0000-4000-8000-000000000002",
        detail: "Second independent memory detail.",
      }),
    ];
    await Promise.all(
      entries.map((entry) =>
        store.mutate("project", async ({ current }) => ({
          file: { version: 1, entries: [...current.entries, entry] },
          value: undefined,
        })),
      ),
    );
    expect((await store.read("project")).entries).toHaveLength(2);
  });

  it("preserves the old file when the next mutation is rejected", async () => {
    const store = await createStore();
    const entry = createMemoryFixtureEntry();
    await store.mutate("project", () => ({
      file: { version: 1, entries: [entry] },
      value: undefined,
    }));
    await expect(
      store.mutate("project", () => ({
        file: { version: 1, entries: [{ ...entry, scope: "user" }] },
        value: undefined,
      })),
    ).rejects.toBeInstanceOf(PersistentMemoryStoreError);
    expect((await store.read("project")).entries[0]?.id).toBe(entry.id);
  });
});
