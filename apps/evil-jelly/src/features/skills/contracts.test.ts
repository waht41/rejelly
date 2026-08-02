import { describe, expect, it } from "vitest";
import { validatePluginId } from "../../services/plugin/contracts";
import { EXTENSION_LIMITS } from "../../shared/extensionLimits";
import { qualifiedSkillName, type SkillRecord, validateSkillName } from "./contracts";

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
    expect(validateSkillName("a".repeat(EXTENSION_LIMITS.skillNameChars)).ok).toBe(true);
    expect(validateSkillName("a".repeat(EXTENSION_LIMITS.skillNameChars + 1)).ok).toBe(false);
  });

  it.each(["com.example.plugin", "plugin", "a.b-c.d2"])("accepts valid plugin id %j", (id) => {
    expect(validatePluginId(id)).toEqual({ ok: true, value: id });
  });

  it.each([
    "",
    "Com.example",
    ".example",
    "example.",
    "example..plugin",
    "example.-plugin",
  ])("rejects invalid plugin id %j", (id) => {
    expect(validatePluginId(id).ok).toBe(false);
  });

  it("enforces the plugin id length boundary", () => {
    expect(validatePluginId("a".repeat(EXTENSION_LIMITS.pluginIdChars)).ok).toBe(true);
    expect(validatePluginId("a".repeat(EXTENSION_LIMITS.pluginIdChars + 1)).ok).toBe(false);
  });
});

describe("qualifiedSkillName", () => {
  it("derives a qualified name instead of storing one on the skill record", () => {
    const skill: SkillRecord = {
      name: "review-code",
      description: "Review code",
      provenance: {
        kind: "plugin",
        pluginId: "com.example.plugin",
        contributionKind: "skill",
        contributionId: "review-code",
      },
      instruction: "Review the code.",
      resources: [],
    };

    expect(qualifiedSkillName(skill)).toBe("com.example.plugin:review-code");
    expect(skill).not.toHaveProperty("qualifiedName");
    expect(skill).not.toHaveProperty("instructionRealPath");
  });
});

describe("skill limits", () => {
  it("freezes the shared v1 limit table", () => {
    expect(Object.isFrozen(EXTENSION_LIMITS)).toBe(true);
  });
});
