import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PersistentMemoryServiceImpl } from "./persistentMemoryServiceImpl";

const temporaryRoots: string[] = [];

async function createService(): Promise<PersistentMemoryServiceImpl> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "evil-memory-service-workspace-"));
  const memoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evil-memory-service-root-"));
  temporaryRoots.push(workspace, memoryRoot);
  return new PersistentMemoryServiceImpl({ workspaceRoot: workspace, memoryRoot });
}

const source = { source: "slash_command" as const, sessionId: "session-1", turnId: "turn-1" };
const confirmation = (proposalSha256: string) => ({
  proposalSha256,
  confirmedAt: "2026-01-02T00:00:00.000Z",
  confirmedBy: "user" as const,
  confirmationSurface: "interactive_prompt" as const,
});

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("persistent memory service Phase 1 contract", () => {
  it("proposes an add without writing, then commits after matching confirmation", async () => {
    const service = await createService();
    const proposal = await service.proposeAdd(
      { title: "Package manager", summary: "Use pnpm.", detail: "Run checks with pnpm." },
      source,
    );
    expect((await service.list()).entries).toHaveLength(0);

    const result = await service.commitConfirmed(proposal, confirmation(proposal.proposalSha256));
    expect(result.status).toBe("committed");
    expect(result.entry).toMatchObject({
      id: proposal.id,
      scope: "project",
      revision: 1,
      provenance: {
        created: { source: "slash_command", sessionId: "session-1", turnId: "turn-1" },
      },
    });
    expect((await service.list()).entries).toHaveLength(1);
  });

  it("rejects confirmation for a different proposal and keeps the store unchanged", async () => {
    const service = await createService();
    const proposal = await service.proposeAdd(
      {
        title: "Language",
        summary: "Answer in Chinese.",
        detail: "Use Chinese unless code requires otherwise.",
      },
      source,
    );
    const result = await service.commitConfirmed(proposal, confirmation("a".repeat(64)));
    expect(result).toEqual({ status: "not_confirmed", code: "not_confirmed" });
    expect((await service.list()).entries).toHaveLength(0);
  });

  it("deduplicates add by detail and requires explicit project scope only for add", async () => {
    const service = await createService();
    const first = await service.proposeAdd(
      { title: "One", summary: "First.", detail: "Same detail." },
      source,
    );
    const committed = await service.commitConfirmed(first, confirmation(first.proposalSha256));
    expect(committed.status).toBe("committed");
    expect((await service.list()).entries).toHaveLength(1);
    await expect(
      service.proposeAdd({ title: "Two", summary: "Second.", detail: " Same detail. " }, source),
    ).rejects.toMatchObject({ code: "unchanged" });
    const userProposal = await service.proposeAdd(
      { title: "Language", summary: "Chinese.", detail: "Use Chinese globally.", scope: "user" },
      source,
    );
    expect(userProposal.scope).toBe("user");
  });

  it("updates with CAS, preserves creation provenance, and increments revision", async () => {
    const service = await createService();
    const add = await service.proposeAdd(
      { title: "One", summary: "First.", detail: "Original detail." },
      source,
    );
    const added = await service.commitConfirmed(add, confirmation(add.proposalSha256));
    const update = await service.proposeUpdate(
      { id: added.id!, summary: "Updated summary." },
      { source: "agent_tool", sessionId: "session-2", turnId: "turn-2" },
    );
    const updated = await service.commitConfirmed(update, confirmation(update.proposalSha256));
    expect(updated.entry).toMatchObject({
      id: added.id,
      summary: "Updated summary.",
      revision: 2,
      provenance: {
        created: { sessionId: "session-1" },
        lastModified: { sessionId: "session-2", source: "agent_tool" },
      },
    });

    const stale = await service.commitConfirmed(update, confirmation(update.proposalSha256));
    expect(stale.status).toBe("conflict");
  });

  it("deletes exactly by stable ID and exposes independent scope diagnostics", async () => {
    const service = await createService();
    const add = await service.proposeAdd(
      { title: "Delete me", summary: "Temporary.", detail: "Delete this exact item." },
      source,
    );
    await service.commitConfirmed(add, confirmation(add.proposalSha256));
    const deletion = await service.proposeDelete({ id: add.id }, source);
    const result = await service.commitConfirmed(deletion, confirmation(deletion.proposalSha256));
    expect(result).toMatchObject({ status: "committed", id: add.id, scope: "project" });
    expect((await service.list()).entries).toHaveLength(0);

    const userFile = service.store.filePath("user");
    await fs.mkdir(path.dirname(userFile), { recursive: true });
    await fs.writeFile(userFile, "malformed", "utf8");
    const listed = await service.list();
    expect(listed.status).toBe("ok");
    expect(listed.entries).toHaveLength(0);
    expect(listed.diagnostic).toContain("user:");
  });

  it("loads only confirmed entries and reports malformed scopes without throwing", async () => {
    const service = await createService();
    const projectFile = service.store.filePath("project");
    await fs.mkdir(path.dirname(projectFile), { recursive: true });
    await fs.writeFile(projectFile, '{"version":2,"entries":[]}', "utf8");
    const context = await service.loadContext();
    expect(context.entries).toEqual([]);
    expect(context.diagnostics.join("\n")).toContain("project:");
  });
});
