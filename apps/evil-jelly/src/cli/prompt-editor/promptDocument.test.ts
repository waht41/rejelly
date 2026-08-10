import { describe, expect, it } from "vitest";
import {
  documentLogicalLength,
  projectedDisplayRuns,
  projectPromptDocument,
  promptTokens,
  replacePromptRange,
  type SkillPromptToken,
  textPromptDocument,
} from "./promptDocument";

const skill: SkillPromptToken = {
  type: "token",
  kind: "skill",
  id: "skill-1",
  qualifiedName: "project:review",
  displayText: "$review",
};

describe("PromptDocument", () => {
  it("counts a semantic token as one logical position", () => {
    const document = replacePromptRange(textPromptDocument("ab"), 1, 1, [skill]);
    const projection = projectPromptDocument(document);

    expect(documentLogicalLength(document)).toBe(3);
    expect(projection.text).toBe("a$reviewb");
    expect(projection.logicalToDisplay(1)).toBe(1);
    expect(projection.logicalToDisplay(2)).toBe(8);
  });

  it("snaps display offsets inside a token to a requested logical edge", () => {
    const document = replacePromptRange(textPromptDocument("ab"), 1, 1, [skill]);
    const projection = projectPromptDocument(document);

    expect(projection.displayToLogical(4, "left")).toBe(1);
    expect(projection.displayToLogical(4, "right")).toBe(2);
    expect(projection.displayToLogical(2, "nearest")).toBe(1);
    expect(projection.displayToLogical(7, "nearest")).toBe(2);
  });

  it("replaces a token as one logical unit and preserves surrounding text", () => {
    const withSkill = replacePromptRange(textPromptDocument("a b"), 1, 1, [skill]);
    const removed = replacePromptRange(withSkill, 1, 2, []);

    expect(projectPromptDocument(removed).text).toBe("a b");
    expect(promptTokens(removed)).toEqual([]);
  });

  it("splits a display row into dedicated token render runs", () => {
    const document = replacePromptRange(textPromptDocument("ab"), 1, 1, [skill]);
    const projection = projectPromptDocument(document);

    expect(projectedDisplayRuns(projection.text, 0, projection.tokenSpans)).toEqual([
      { text: "a" },
      { text: "$review", token: skill },
      { text: "b" },
    ]);
  });
});
