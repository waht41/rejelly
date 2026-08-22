import { describe, expect, it, vi } from "vitest";
import type { PersistentMemoryEntryV1 } from "../../domains/memory/model/memorySchema";
import type { SessionMemoryRuntime } from "../../domains/memory/runtime/sessionMemoryRuntime";
import type { MemoryMutationProposal } from "../../domains/memory/service/memoryMutationProposal";
import type { PersistentMemoryService } from "../../domains/memory/service/persistentMemoryService";
import type { MemoryCommandPorts } from "./memoryCommands";
import { handleMemoryCommand, isMemoryLocalCommand } from "./memoryCommands";

const id = "mem_12345678-1234-4123-8123-123456789abc";

function entry(overrides: Partial<PersistentMemoryEntryV1> = {}): PersistentMemoryEntryV1 {
  const provenance = {
    source: "slash_command" as const,
    proposedAt: "2025-01-01T00:00:00.000Z",
    confirmedAt: "2025-01-01T00:00:00.000Z",
    confirmedBy: "user" as const,
    confirmationSurface: "interactive_prompt" as const,
    proposalSha256: "a".repeat(64),
  };
  return {
    id,
    scope: "project",
    title: "Old title",
    summary: "Old summary",
    detail: "Old detail",
    revision: 1,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    provenance: { created: provenance, lastModified: provenance },
    ...overrides,
  };
}

function proposal(current: PersistentMemoryEntryV1): MemoryMutationProposal {
  return {
    version: 1,
    operation: "update",
    scope: current.scope,
    id: current.id,
    expectedRevision: current.revision,
    before: current,
    after: { ...current, title: "New title" },
    source: { source: "slash_command" },
    proposedAt: "2025-01-01T00:00:00.000Z",
    proposalSha256: "b".repeat(64),
  };
}

function ports(overrides: Partial<MemoryCommandPorts> = {}): MemoryCommandPorts & {
  logSystem: ReturnType<typeof vi.fn>;
  requestConfirmation: ReturnType<typeof vi.fn>;
} {
  const current = entry();
  const service = {
    list: vi.fn(async () => ({ status: "ok" as const, scope: "all" as const, entries: [current] })),
    proposeAdd: vi.fn(),
    proposeUpdate: vi.fn(async () => proposal(current)),
    proposeDelete: vi.fn(),
    commitConfirmed: vi.fn(async () => ({
      status: "committed" as const,
      id,
      scope: "project" as const,
    })),
    loadContext: vi.fn(),
  } satisfies PersistentMemoryService;
  return {
    service,
    logSystem: vi.fn(),
    requestConfirmation: vi.fn(async () => ({ action: "reject" as const })),
    ...overrides,
  } as MemoryCommandPorts & {
    logSystem: ReturnType<typeof vi.fn>;
    requestConfirmation: ReturnType<typeof vi.fn>;
  };
}

describe("persistent memory commands", () => {
  it("reserves only the supported command grammar", () => {
    expect(isMemoryLocalCommand("/memory")).toBe(true);
    expect(isMemoryLocalCommand(`/memory show ${id}`)).toBe(true);
    expect(isMemoryLocalCommand(`/memory edit ${id} title New title`)).toBe(true);
    expect(isMemoryLocalCommand(`/memory delete ${id}`)).toBe(true);
    expect(isMemoryLocalCommand("/memory 是怎么实现的？")).toBe(false);
    expect(isMemoryLocalCommand("/memory list")).toBe(false);
  });

  it("renders a live catalog grouped by scope", async () => {
    const command = ports();
    await handleMemoryCommand("/memory", command);
    expect(command.logSystem).toHaveBeenCalledWith(expect.stringContaining("Project Memory"));
    expect(command.logSystem).toHaveBeenCalledWith(expect.stringContaining(id));
  });

  it("keeps deleted frozen entries visible until the next epoch", async () => {
    const current = entry();
    const command = ports({
      service: {
        list: vi.fn(async () => ({ status: "ok" as const, scope: "all" as const, entries: [] })),
        proposeAdd: vi.fn(),
        proposeUpdate: vi.fn(),
        proposeDelete: vi.fn(),
        commitConfirmed: vi.fn(),
        loadContext: vi.fn(),
      } as unknown as PersistentMemoryService,
      runtime: {
        epoch: {
          entries: [
            {
              id: current.id,
              scope: current.scope,
              title: current.title,
              summary: current.summary,
            },
          ],
        },
        statusFor: () => "removed_next_epoch" as const,
      } as unknown as SessionMemoryRuntime,
    });
    await handleMemoryCommand("/memory", command);
    expect(command.logSystem).toHaveBeenCalledWith(expect.stringContaining("removed next epoch"));
  });

  it("requires confirmation and does not write after rejection", async () => {
    const command = ports();
    await handleMemoryCommand(`/memory edit ${id} title New title`, command);
    expect(command.requestConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "update",
        expectedRevision: 1,
        before: expect.objectContaining({ revision: 1 }),
        after: expect.objectContaining({ revision: 2 }),
        source: expect.objectContaining({ source: "slash_command" }),
      }),
    );
    expect(command.service.commitConfirmed).not.toHaveBeenCalled();
    expect(command.logSystem).toHaveBeenCalledWith(expect.stringContaining("rejected"));
  });

  it("commits an accepted edit and reports the next epoch effect", async () => {
    const command = ports({
      requestConfirmation: vi.fn(async () => ({ action: "accept" as const })),
    });
    await handleMemoryCommand(`/memory edit ${id} title New title`, command);
    expect(command.service.commitConfirmed).toHaveBeenCalledOnce();
    expect(command.logSystem).toHaveBeenCalledWith(
      expect.stringContaining("next session or compaction"),
    );
  });

  it("opens the human-only memory manager and reveals the selected scope file", async () => {
    const revealMemoryFile = vi.fn(async () => undefined);
    const requestMemoryManager = vi
      .fn()
      .mockResolvedValueOnce({ action: "detail" as const, id })
      .mockResolvedValueOnce({ action: "reveal_file" as const, id })
      .mockResolvedValueOnce({ action: "close" as const });
    const command = ports({ requestMemoryManager, revealMemoryFile });
    await handleMemoryCommand("/memory", command);
    expect(requestMemoryManager).toHaveBeenCalledWith(
      expect.objectContaining({ canRevealFile: true }),
    );
    expect(revealMemoryFile).toHaveBeenCalledWith("project");
    expect(command.logSystem).not.toHaveBeenCalledWith(expect.stringContaining("/memory"));
  });

  it("renders detail, provenance, and injected status", async () => {
    const command = ports({
      runtime: { statusFor: () => "current" } as unknown as SessionMemoryRuntime,
    });
    await handleMemoryCommand(`/memory show ${id}`, command);
    expect(command.logSystem).toHaveBeenCalledWith(expect.stringContaining("Provenance:"));
    expect(command.logSystem).toHaveBeenCalledWith(expect.stringContaining("Injected: current"));
  });
});
