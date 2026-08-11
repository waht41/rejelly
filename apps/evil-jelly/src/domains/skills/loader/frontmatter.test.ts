import { describe, expect, it } from "vitest";
import { parseSkillMarkdown } from "./frontmatter";
import { SKILL_LOADER_LIMITS } from "./limits";

describe("skill frontmatter", () => {
  it("parses the v1 fields, defaults the name, and preserves bounded extras", () => {
    const result = parseSkillMarkdown(
      `---
description: Review the current change
metadata:
  short-description: Fast review
  display-hint: compact
future-field:
  enabled: true
---
Follow the review workflow exactly.
`,
      "review-code",
    );

    expect(result).toEqual({
      ok: true,
      value: {
        name: "review-code",
        description: "Review the current change",
        shortDescription: "Fast review",
        instruction: "Follow the review workflow exactly.\n",
        extras: {
          "future-field": { enabled: true },
          metadata: { "display-hint": "compact" },
        },
      },
    });
    if (result.ok) {
      expect(Object.isFrozen(result.value.extras)).toBe(true);
    }
  });

  it.each([
    ["missing delimiters", "description: nope"],
    ["missing description", "---\nname: review\n---\nbody"],
    ["duplicate key", "---\ndescription: first\ndescription: second\n---\nbody"],
    ["custom tag", "---\ndescription: !custom nope\n---\nbody"],
    ["anchor and alias", "---\ndescription: &desc review\ncopy: *desc\n---\nbody"],
    ["merge key", '---\ndescription: review\n"<<": { extra: true }\n---\nbody'],
    ["invalid name", "---\nname: Review Code\ndescription: review\n---\nbody"],
    ["control character", "---\ndescription: review\n---\nbody\u0000"],
  ])("rejects %s", (_label, raw) => {
    expect(parseSkillMarkdown(raw, "fallback").ok).toBe(false);
  });

  it("enforces frontmatter byte and node-depth limits", () => {
    const oversized = `---\ndescription: ${"x".repeat(SKILL_LOADER_LIMITS.frontmatterBytes)}\n---\nbody`;
    expect(parseSkillMarkdown(oversized, "fallback").ok).toBe(false);

    const lines = ["---", "description: review", "deep:"];
    for (let depth = 0; depth < SKILL_LOADER_LIMITS.frontmatterDepth + 2; depth++) {
      lines.push(`${"  ".repeat(depth + 1)}level:`);
    }
    lines.push(`${"  ".repeat(SKILL_LOADER_LIMITS.frontmatterDepth + 3)}value`, "---", "body");
    expect(parseSkillMarkdown(lines.join("\n"), "fallback").ok).toBe(false);
  });
});
