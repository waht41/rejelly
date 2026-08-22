import { describe, expect, it } from "vitest";
import { createMemoryFixtureEntry, createMemoryFixtureFile } from "../__tests__/memoryTestFixtures";
import {
  assertMemoryFileByteLimit,
  memoryAddInputSchema,
  memoryConfirmationSchema,
  memoryListInputSchema,
  memoryUpdateInputSchema,
  PERSISTENT_MEMORY_LIMITS,
  parseScopedMemoryFile,
  persistentMemoryFileV1Schema,
  projectMemoryFileV1Schema,
  userMemoryFileV1Schema,
} from "./memorySchema";

const validEntry = createMemoryFixtureEntry();

describe("persistent memory Phase 0 contract", () => {
  it.each([
    ["valid project file", createMemoryFixtureFile(), true],
    ["valid empty user file", createMemoryFixtureFile("user", []), true],
    ["unknown schema version", { version: 2, entries: [] }, false],
    ["unknown top-level field", { ...createMemoryFixtureFile(), extra: true }, false],
    ["generic file accepts either scope", createMemoryFixtureFile("user", [validEntry]), true],
    ["duplicate entry id", createMemoryFixtureFile("project", [validEntry, validEntry]), false],
  ])("validates %s", (_name, value, expected) => {
    expect(persistentMemoryFileV1Schema.safeParse(value).success).toBe(expected);
  });

  it("uses project as the add default and trims bounded text", () => {
    expect(
      memoryAddInputSchema.parse({
        title: "  Package manager  ",
        summary: "  Use pnpm.  ",
        detail: "  Run checks with pnpm.  ",
      }),
    ).toEqual({
      title: "Package manager",
      summary: "Use pnpm.",
      detail: "Run checks with pnpm.",
      scope: "project",
    });
  });

  it("counts Unicode code points instead of UTF-16 code units", () => {
    const emoji = "😀".repeat(PERSISTENT_MEMORY_LIMITS.maxTitleCodePoints);
    expect(
      memoryAddInputSchema.safeParse({
        title: emoji,
        summary: "A valid summary",
        detail: "A valid detail",
      }).success,
    ).toBe(true);
    expect(
      memoryAddInputSchema.safeParse({
        title: `${emoji}😀`,
        summary: "A valid summary",
        detail: "A valid detail",
      }).success,
    ).toBe(false);
  });

  it.each([
    ["empty update", { id: validEntry.id }, false],
    ["unknown update field", { id: validEntry.id, reason: "not allowed" }, false],
    ["valid update", { id: validEntry.id, summary: "A new summary" }, true],
  ])("checks update shape: %s", (_name, value, expected) => {
    expect(memoryUpdateInputSchema.safeParse(value).success).toBe(expected);
  });

  it("requires explicit ids for detail reads and rejects duplicate ids", () => {
    expect(memoryListInputSchema.safeParse({ view: "detail" }).success).toBe(false);
    expect(
      memoryListInputSchema.safeParse({ view: "detail", ids: [validEntry.id, validEntry.id] })
        .success,
    ).toBe(false);
    expect(memoryListInputSchema.parse({ ids: [validEntry.id], view: "detail" })).toMatchObject({
      scope: "all",
      view: "detail",
    });
  });

  it("requires host-owned confirmation fields", () => {
    const hash = "a".repeat(64);
    expect(
      memoryConfirmationSchema.safeParse({
        proposalSha256: hash,
        confirmedAt: "2026-01-01T00:00:00.000Z",
        confirmedBy: "user",
        confirmationSurface: "interactive_prompt",
      }).success,
    ).toBe(true);
    expect(
      memoryConfirmationSchema.safeParse({
        proposalSha256: hash,
        confirmedAt: "2026-01-01T00:00:00.000Z",
        confirmedBy: "model",
        confirmationSurface: "interactive_prompt",
      }).success,
    ).toBe(false);
  });

  it("enforces scope-specific file schemas and the serialized byte ceiling", () => {
    expect(userMemoryFileV1Schema.safeParse(createMemoryFixtureFile("user", [])).success).toBe(
      true,
    );
    expect(projectMemoryFileV1Schema.safeParse(createMemoryFixtureFile()).success).toBe(true);
    expect(() => parseScopedMemoryFile(createMemoryFixtureFile(), "user")).toThrow();
    expect(() => assertMemoryFileByteLimit(createMemoryFixtureFile())).not.toThrow();
  });
});
