import { describe, expect, it } from "vitest";
import { qualifiedSkillName, type SkillRecord, skillOrigin } from "./contracts";
import { SKILL_LIMITS } from "./limits";
import { createSkillCatalog } from "./skillCatalog";

function record(
  scope: "user" | "project",
  name: string,
  description = `Description for ${name}`,
): SkillRecord {
  return Object.freeze({
    name,
    description,
    origin: skillOrigin(scope),
    instruction: `Instruction for ${name}`,
    resources: Object.freeze([]),
  });
}

describe("SkillCatalog", () => {
  it("sorts entries and resolves qualified or globally unique plain names", () => {
    const project = record("project", "review");
    const user = record("user", "explain");
    const catalog = createSkillCatalog([user, project]);

    expect(catalog.entries.map(qualifiedSkillName)).toEqual(["project:review", "user:explain"]);
    expect(catalog.resolve("project:review")).toEqual({ ok: true, skill: project });
    expect(catalog.resolve(" explain ")).toEqual({ ok: true, skill: user });
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.entries)).toBe(true);
  });

  it("returns sorted qualified candidates for an ambiguous plain name", () => {
    const catalog = createSkillCatalog([record("user", "review"), record("project", "review")]);

    expect(catalog.resolve("review")).toEqual({
      ok: false,
      reason: "ambiguous",
      candidates: ["project:review", "user:review"],
    });
  });

  it("returns bounded deterministic suggestions for a missing name", () => {
    const catalog = createSkillCatalog([
      record("user", "review"),
      record("project", "preview"),
      record("user", "rewrite"),
      record("project", "explain"),
      record("user", "search"),
      record("project", "test"),
    ]);

    const result = catalog.resolve("reviw");

    expect(result).toMatchObject({ ok: false, reason: "not-found" });
    if (!result.ok) {
      expect(result.candidates[0]).toBe("user:review");
      expect(result.candidates).toHaveLength(5);
      expect(Object.isFrozen(result.candidates)).toBe(true);
    }
  });

  it("paginates with snapshot-bound opaque cursors and bounded DTO output", () => {
    const records = Array.from({ length: SKILL_LIMITS.listPageEntries + 5 }, (_, index) =>
      record("project", `skill-${index.toString().padStart(3, "0")}`, "x".repeat(1_000)),
    );
    const catalog = createSkillCatalog(records);
    const first = catalog.list();
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }

    expect(first.page.returned).toBeLessThanOrEqual(SKILL_LIMITS.listPageEntries);
    expect(first.page.nextCursor).toBeTypeOf("string");
    expect(JSON.stringify(first.page).length).toBeLessThanOrEqual(SKILL_LIMITS.listPageOutputChars);
    expect(first.page.items.every((item) => [...item.description].length <= 250)).toBe(true);
    expect(Object.isFrozen(first.page)).toBe(true);
    expect(Object.isFrozen(first.page.items)).toBe(true);

    const second = catalog.list(first.page.nextCursor);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.page.items[0]?.qualifiedName).toBe(
        first.page.items[first.page.items.length - 1]!.qualifiedName.replace(/\d{3}$/, (value) =>
          (Number(value) + 1).toString().padStart(3, "0"),
        ),
      );
      expect(second.page.total).toBe(records.length);
    }
  });

  it("rejects malformed, out-of-range, and foreign snapshot cursors", () => {
    const records = Array.from({ length: 51 }, (_, index) =>
      record("user", `skill-${index.toString().padStart(3, "0")}`),
    );
    const firstCatalog = createSkillCatalog(records);
    const firstPage = firstCatalog.list();
    if (!firstPage.ok || !firstPage.page.nextCursor) {
      throw new Error("fixture did not produce a cursor");
    }
    const foreignCatalog = createSkillCatalog([
      ...records.slice(0, -1),
      record("user", "different-last-skill"),
    ]);

    expect(firstCatalog.list("not-a-cursor")).toEqual({
      ok: false,
      reason: "invalid-cursor",
    });
    expect(
      firstCatalog.list(Buffer.from("skill-v1:00000000:999", "utf8").toString("base64url")),
    ).toEqual({ ok: false, reason: "invalid-cursor" });
    expect(foreignCatalog.list(firstPage.page.nextCursor)).toEqual({
      ok: false,
      reason: "invalid-cursor",
    });
  });

  it("throws when an upstream invariant admits duplicate qualified names", () => {
    expect(() =>
      createSkillCatalog([record("project", "same"), record("project", "same")]),
    ).toThrow(/duplicate qualified name/);
  });
});
