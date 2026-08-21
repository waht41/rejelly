import { createHash } from "node:crypto";
import type {
  MemoryScope,
  PersistentMemoryEntryV1,
  PersistentMemoryFileV1,
} from "../model/memorySchema";

export const MEMORY_FIXTURE_TIMESTAMP = "2026-01-01T00:00:00.000Z";

export function createMemoryFixtureEntry(
  overrides: Partial<PersistentMemoryEntryV1> = {},
): PersistentMemoryEntryV1 {
  const id = overrides.id ?? "mem_00000000-0000-4000-8000-000000000001";
  const scope = overrides.scope ?? "project";
  const proposalSha256 = createHash("sha256").update(id).digest("hex");
  const provenance = {
    source: "slash_command" as const,
    proposedAt: MEMORY_FIXTURE_TIMESTAMP,
    confirmedAt: MEMORY_FIXTURE_TIMESTAMP,
    confirmedBy: "user" as const,
    confirmationSurface: "interactive_prompt" as const,
    proposalSha256,
  };

  return {
    id,
    scope,
    title: "Package manager",
    summary: "Use pnpm for this repository.",
    detail: "Install dependencies and run verification with pnpm.",
    revision: 1,
    createdAt: MEMORY_FIXTURE_TIMESTAMP,
    updatedAt: MEMORY_FIXTURE_TIMESTAMP,
    provenance: { created: provenance, lastModified: provenance },
    ...overrides,
  };
}

export function createMemoryFixtureFile(
  scope: MemoryScope = "project",
  entries: readonly PersistentMemoryEntryV1[] = [createMemoryFixtureEntry({ scope })],
): PersistentMemoryFileV1 {
  return { version: 1, entries: [...entries] };
}
