import { describe, expect, it } from "vitest";
import { createMemoryFixtureEntry } from "../__tests__/memoryTestFixtures";
import type { PersistentMemoryService } from "../service/persistentMemoryService";
import { createSessionMemoryRuntime, refreshMemoryInstructionPrefix } from "./sessionMemoryRuntime";

function createService(
  entries: readonly ReturnType<typeof createMemoryFixtureEntry>[],
): PersistentMemoryService {
  return {
    list: async () => ({ status: "ok", scope: "all", entries }),
    loadContext: async () => ({ entries, diagnostics: [] }),
    proposeAdd: async () => {
      throw new Error("not used in runtime tests");
    },
    proposeUpdate: async () => {
      throw new Error("not used in runtime tests");
    },
    proposeDelete: async () => {
      throw new Error("not used in runtime tests");
    },
    commitConfirmed: async () => {
      throw new Error("not used in runtime tests");
    },
  };
}

describe("SessionMemoryRuntime", () => {
  it("freezes an index until refresh and reports live state transitions", async () => {
    const entry = createMemoryFixtureEntry();
    const added = createMemoryFixtureEntry({
      id: "mem_00000000-0000-4000-8000-000000000002",
      title: "Second memory",
      summary: "Another indexed entry.",
    });
    let liveEntries = [entry];
    const service = createService(liveEntries);
    service.loadContext = async () => ({ entries: liveEntries, diagnostics: [] });
    const runtime = await createSessionMemoryRuntime(service);
    const initialInstruction = runtime.epoch.instruction;

    liveEntries = [createMemoryFixtureEntry({ ...entry, summary: "Updated live summary." }), added];
    expect(runtime.epoch.instruction).toBe(initialInstruction);
    expect(runtime.statusFor(entry.id, liveEntries[0])).toBe("pending_next_epoch");
    expect(runtime.statusFor(added.id, added)).toBe("pending_next_epoch");
    expect(runtime.statusFor(entry.id)).toBe("removed_next_epoch");

    await runtime.refresh();
    expect(runtime.epoch.instruction).not.toBe(initialInstruction);
    expect(runtime.statusFor(entry.id, liveEntries[0])).toBe("current");
    expect(runtime.statusFor(added.id, added)).toBe("current");
  });

  it("keeps the previous epoch when refresh fails", async () => {
    const entry = createMemoryFixtureEntry();
    const service = createService([entry]);
    const runtime = await createSessionMemoryRuntime(service);
    const epoch = runtime.epoch;
    service.loadContext = async () => {
      throw new Error("malformed project store");
    };

    await expect(runtime.refresh()).resolves.toBe(epoch);
    expect(runtime.epoch).toBe(epoch);
    expect(runtime.diagnostics.at(-1)).toContain("malformed project store");
  });

  it("replaces only the owned memory instruction and preserves other instructions", () => {
    const oldMemory = "<persistent-memory>old</persistent-memory>";
    const current = {
      system: [{ role: "system" as const, content: "system" }],
      instruction: [
        { role: "user" as const, content: "workspace instructions" },
        {
          role: "user" as const,
          content: oldMemory,
          extra: { rejelly: { kind: "instruction", owner: "persistent-memory" } },
        },
      ],
    };
    const refreshed = refreshMemoryInstructionPrefix(
      current,
      "<persistent-memory>new</persistent-memory>",
    );

    expect(refreshed.system).toEqual(current.system);
    expect(refreshed.instruction).toHaveLength(2);
    expect(refreshed.instruction[0]).toEqual(current.instruction[0]);
    expect(refreshed.instruction[1]).toMatchObject({
      content: "<persistent-memory>new</persistent-memory>",
      extra: { rejelly: { owner: "persistent-memory" } },
    });
  });
});
