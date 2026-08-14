import { describe, expect, it } from "vitest";
import { SKILL_DEFINITION_LIMITS } from "./limits";
import { qualifiedSkillName, type SkillRecord, validateSkillName } from "./skillDefinition";

describe("skill identifiers", () => {
  it("trims valid skill names without rewriting their content", () => {
    expect(validateSkillName("  review-code_v2.1  ")).toEqual({
      ok: true,
      value: "review-code_v2.1",
    });
  });

  it.each([
    "",
    "Review-Code",
    "review code",
    "-review",
    "review:code",
    "审查代码",
  ])("rejects invalid skill name %j", (name) => {
    expect(validateSkillName(name).ok).toBe(false);
  });

  it("enforces the skill name length boundary", () => {
    expect(validateSkillName("a".repeat(SKILL_DEFINITION_LIMITS.skillNameChars)).ok).toBe(true);
    expect(validateSkillName("a".repeat(SKILL_DEFINITION_LIMITS.skillNameChars + 1)).ok).toBe(
      false,
    );
  });
});

describe("qualifiedSkillName", () => {
  it("derives a qualified name instead of storing one on the skill record", () => {
    const skill: SkillRecord = {
      name: "review-code",
      description: "Review code",
      origin: { scope: "project" },
      instruction: "Review the code.",
      resources: [],
    };

    expect(qualifiedSkillName(skill)).toBe("project:review-code");
    expect(skill).not.toHaveProperty("qualifiedName");
    expect(skill).not.toHaveProperty("instructionRealPath");
  });
});

describe("skill limits", () => {
  it("freezes the shared v1 limit table", () => {
    expect(Object.isFrozen(SKILL_DEFINITION_LIMITS)).toBe(true);
  });
});
