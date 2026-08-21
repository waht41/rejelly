import { describe, expect, it } from "vitest";
import { createMemoryFixtureEntry } from "../__tests__/memoryTestFixtures";
import {
  MEMORY_ERROR_CODES,
  memoryMutationProposalSchema,
  PersistentMemoryError,
} from "./memoryMutationProposal";

const entry = createMemoryFixtureEntry();
const hash = "a".repeat(64);
const source = { source: "slash_command" as const };

function proposal(operation: "add" | "update" | "delete", overrides: Record<string, unknown> = {}) {
  const base = {
    version: 1 as const,
    operation,
    scope: entry.scope,
    id: entry.id,
    expectedRevision: operation === "add" ? 0 : entry.revision,
    source,
    proposedAt: "2026-01-01T00:00:00.000Z",
    proposalSha256: hash,
  };
  if (operation === "add") return { ...base, after: entry, ...overrides };
  if (operation === "update") return { ...base, before: entry, after: entry, ...overrides };
  return { ...base, before: entry, ...overrides };
}

describe("persistent memory mutation proposal contract", () => {
  it.each([
    ["add", proposal("add"), true],
    ["update", proposal("update"), true],
    ["delete", proposal("delete"), true],
    ["add with before", proposal("add", { before: entry }), false],
    ["update without before", proposal("update", { before: undefined }), false],
    ["delete with after", proposal("delete", { after: entry }), false],
    ["scope mismatch", proposal("update", { after: { ...entry, scope: "user" } }), false],
    ["unknown field", proposal("add", { unexpected: true }), false],
  ])("validates %s", (_name, value, expected) => {
    expect(memoryMutationProposalSchema.safeParse(value).success).toBe(expected);
  });

  it("exposes stable error codes for later store/service implementations", () => {
    expect(MEMORY_ERROR_CODES).toMatchObject({
      duplicate: "duplicate",
      unchanged: "unchanged",
      notConfirmed: "not_confirmed",
      conflict: "conflict",
    });
    expect(new PersistentMemoryError("conflict", "proposal is stale")).toBeInstanceOf(Error);
  });
});
