import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersistentMemoryServiceImpl } from "../service/persistentMemoryServiceImpl";
import {
  createMemoryEditTool,
  createMemoryReadTool,
  createMemoryTools,
  memoryEditParameters,
  memoryReadParameters,
} from "./memoryTools";

const source = { source: "agent_tool" as const, turnId: "turn-1" };
const temporaryRoots: string[] = [];

async function createService(): Promise<PersistentMemoryServiceImpl> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "evil-memory-agent-workspace-"));
  const memoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evil-memory-agent-root-"));
  temporaryRoots.push(workspace, memoryRoot);
  return new PersistentMemoryServiceImpl({ workspaceRoot: workspace, memoryRoot });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("memory agent tools", () => {
  it("uses object-root schemas and exposes exactly two tools", () => {
    expect(memoryReadParameters.parse({})).toMatchObject({ scope: "all", view: "catalog" });
    expect(memoryEditParameters._def.typeName).toBeDefined();
  });

  it("reads a live catalog and only exposes detail/provenance in detail view", async () => {
    const service = await createService();
    const add = await service.proposeAdd(
      {
        title: "Style",
        summary: "Use concise replies.",
        detail: "Prefer concise replies in chat.",
      },
      source,
    );
    await service.commitConfirmed(add, {
      proposalSha256: add.proposalSha256,
      confirmedAt: new Date().toISOString(),
      confirmedBy: "user",
      confirmationSurface: "interactive_prompt",
    });

    const read = createMemoryReadTool(service);
    const catalog = (await read.handler({ scope: "all", view: "catalog" })) as {
      status: string;
      view: string;
      entries: Array<Record<string, unknown>>;
    };
    expect(catalog).toMatchObject({ status: "ok", view: "catalog" });
    expect(catalog.entries[0]).toMatchObject({ title: "Style", summary: "Use concise replies." });
    expect(catalog.entries[0]).not.toHaveProperty("detail");
    expect(catalog.entries[0]).not.toHaveProperty("provenance");

    const id = catalog.entries[0]!.id as string;
    const detail = (await read.handler({ scope: "all", ids: [id], view: "detail" })) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(detail.entries[0]).toMatchObject({ detail: "Prefer concise replies in chat." });
    expect(detail.entries[0]).toHaveProperty("provenance");
  });

  it("dispatches add/update/delete and never writes before acceptance", async () => {
    const service = await createService();
    let accepted = false;
    const confirmation = vi.fn(async () => ({
      action: accepted ? ("accept" as const) : ("reject" as const),
    }));
    const edit = createMemoryEditTool({ service, source, requestConfirmation: confirmation });

    const rejected = await edit.handler({
      change: { kind: "add", title: "One", summary: "Summary.", detail: "First detail." },
    });
    expect(rejected).toMatchObject({
      status: "rejected",
      code: "rejected_by_user",
      committed: false,
      message: expect.stringContaining("Nothing was saved"),
    });
    expect((await service.list()).entries).toHaveLength(0);

    accepted = true;
    const added = await edit.handler({
      change: { kind: "add", title: "One", summary: "Summary.", detail: "First detail." },
    });
    expect(added).toMatchObject({
      status: "committed",
      committed: true,
      message: expect.stringContaining("accepted"),
    });
    const id = (added as { id: string }).id;

    const updated = await edit.handler({
      change: { kind: "update", id, summary: "Updated." },
    });
    expect(updated).toMatchObject({ status: "committed", id });
    expect(confirmation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedRevision: 1,
        before: expect.objectContaining({ revision: 1 }),
        after: expect.objectContaining({ revision: 2 }),
      }),
    );

    const deleted = await edit.handler({ change: { kind: "delete", id } });
    expect(deleted).toMatchObject({ status: "committed", id });
    expect((await service.list()).entries).toHaveLength(0);
  });

  it("does not accept a missing confirmation binding in headless mode", async () => {
    const service = await createService();
    const edit = createMemoryEditTool({ service, source });
    const result = await edit.handler({
      change: { kind: "add", title: "One", summary: "Summary.", detail: "No write." },
    });
    expect(result).toMatchObject({
      status: "not_confirmed",
      code: "confirmation_unavailable",
      committed: false,
      message: expect.stringContaining("Nothing was saved"),
    });
    expect((await service.list()).entries).toHaveLength(0);
  });

  it("returns not_found and rejects invalid update input", async () => {
    const service = await createService();
    const edit = createMemoryEditTool({
      service,
      source,
      requestConfirmation: async () => ({ action: "accept" as const }),
    });
    const notFound = await edit.handler({
      change: {
        kind: "update",
        id: "mem_00000000-0000-4000-8000-000000000001",
        summary: "Updated.",
      },
    });
    expect(notFound).toMatchObject({ status: "error", code: "not_found" });
    expect(() =>
      memoryEditParameters.parse({
        change: { kind: "update", id: "mem_00000000-0000-4000-8000-000000000001" },
      }),
    ).toThrow();
  });

  it("creates a kit with only memory_read and memory_edit", () => {
    const tools = createMemoryTools({
      service: {} as PersistentMemoryServiceImpl,
      source,
    });
    expect(tools.map((tool) => tool.name)).toEqual(["memory_read", "memory_edit"]);
  });
});
