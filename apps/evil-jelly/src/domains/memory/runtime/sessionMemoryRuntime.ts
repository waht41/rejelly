import type { Message } from "@rejelly/core";
import type { MemoryInstructionEntry } from "../agent/memoryPrompt";
import { renderMemoryInstruction } from "../agent/memoryPrompt";
import type { PersistentMemoryEntryV1 } from "../model/memorySchema";
import type { PersistentMemoryService } from "../service/persistentMemoryService";

export const MEMORY_RUNTIME_PROVIDER_KEY = "evil-jelly:persistent-memory-runtime:v1";
export const MEMORY_INSTRUCTION_OWNER = "persistent-memory";

export type MemoryInjectedStatus = "current" | "pending_next_epoch" | "removed_next_epoch";

export interface MemoryInstructionEpoch {
  readonly entries: readonly MemoryInstructionEntry[];
  readonly instruction: string;
  readonly createdAt: string;
}

export interface SessionMemoryRuntime {
  readonly service: PersistentMemoryService;
  readonly epoch: MemoryInstructionEpoch;
  readonly diagnostics: readonly string[];
  refresh(): Promise<MemoryInstructionEpoch>;
  statusFor(id: string, liveEntry?: PersistentMemoryEntryV1): MemoryInjectedStatus;
}

function entryProjection(
  entry: Pick<PersistentMemoryEntryV1, "id" | "scope" | "title" | "summary">,
): string {
  return JSON.stringify({
    id: entry.id,
    scope: entry.scope,
    title: entry.title,
    summary: entry.summary,
  });
}

class SessionMemoryRuntimeImpl implements SessionMemoryRuntime {
  #epoch: MemoryInstructionEpoch;
  #diagnostics: readonly string[];

  constructor(
    readonly service: PersistentMemoryService,
    initial: { entries: readonly PersistentMemoryEntryV1[]; diagnostics: readonly string[] },
  ) {
    this.#epoch = createEpoch(initial.entries);
    this.#diagnostics = [...initial.diagnostics];
  }

  get epoch(): MemoryInstructionEpoch {
    return this.#epoch;
  }

  get diagnostics(): readonly string[] {
    return this.#diagnostics;
  }

  async refresh(): Promise<MemoryInstructionEpoch> {
    try {
      const loaded = await this.service.loadContext();
      this.#epoch = createEpoch(loaded.entries);
      this.#diagnostics = [...loaded.diagnostics];
      return this.#epoch;
    } catch (error) {
      // A refresh failure must not discard a usable frozen epoch. The caller can surface the
      // warning while the current prompt continues using its last known prefix.
      this.#diagnostics = [
        ...this.#diagnostics,
        `Memory epoch refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      ];
      return this.#epoch;
    }
  }

  statusFor(id: string, liveEntry?: PersistentMemoryEntryV1): MemoryInjectedStatus {
    const frozen = this.#epoch.entries.find((entry) => entry.id === id);
    if (!frozen) return "pending_next_epoch";
    if (!liveEntry) return "removed_next_epoch";
    return entryProjection(frozen) === entryProjection(liveEntry)
      ? "current"
      : "pending_next_epoch";
  }
}

function createEpoch(entries: readonly PersistentMemoryEntryV1[]): MemoryInstructionEpoch {
  const indexEntries = entries.map((entry) =>
    Object.freeze({
      id: entry.id,
      scope: entry.scope,
      title: entry.title,
      summary: entry.summary,
    }),
  );
  return Object.freeze({
    entries: Object.freeze(indexEntries),
    instruction: renderMemoryInstruction(indexEntries),
    // This timestamp is runtime metadata only and is never rendered into the instruction.
    createdAt: new Date().toISOString(),
  });
}

export async function createSessionMemoryRuntime(
  service: PersistentMemoryService,
): Promise<SessionMemoryRuntime> {
  const loaded = await service.loadContext();
  return new SessionMemoryRuntimeImpl(service, loaded);
}

/** Replace only the application-owned persistent-memory instruction in a compaction prefix. */
export function refreshMemoryInstructionPrefix(
  current: { system: readonly Message[]; instruction: readonly Message[] },
  instruction: string,
  previousInstruction?: string,
): { system: readonly Message[]; instruction: readonly Message[] } {
  const withoutMemory = current.instruction.filter((message) => {
    if (message.extra?.rejelly && typeof message.extra.rejelly === "object") {
      const rejelly = message.extra.rejelly as Record<string, unknown>;
      if (rejelly.owner === MEMORY_INSTRUCTION_OWNER) return false;
    }
    return (
      typeof message.content !== "string" ||
      (previousInstruction !== undefined
        ? message.content !== previousInstruction
        : !message.content.includes("<persistent-memory"))
    );
  });
  return {
    system: current.system,
    instruction: instruction
      ? [
          ...withoutMemory,
          {
            role: "user",
            content: instruction,
            extra: {
              rejelly: { kind: "instruction", owner: MEMORY_INSTRUCTION_OWNER },
            },
          },
        ]
      : withoutMemory,
  };
}
