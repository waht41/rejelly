import { describe, expect, it } from "vitest";
import {
  promptDocumentLogicalLength,
  promptTokens,
  type SkillPromptToken,
  textPromptDocument,
} from "../../../../shared/model/prompt/promptDocument";
import { projectedDisplayRuns, projectPromptDocument, replacePromptRange } from "./promptDocument";

const skill: SkillPromptToken = {
  type: "token",
  kind: "skill",
  qualifiedName: "project:review",
};
const displayToken = () => "$review";

describe("PromptDocument", () => {
  it("derives Skill labels without changing the semantic token", () => {
    const document = [skill];

    expect(projectPromptDocument(document).text).toBe("$project:review");
    expect(projectPromptDocument(document, displayToken).text).toBe("$review");
    expect(document).toEqual([{ type: "token", kind: "skill", qualifiedName: "project:review" }]);
  });

  it("counts a semantic token as one logical position", () => {
    const document = replacePromptRange(textPromptDocument("ab"), 1, 1, [skill]);
    const projection = projectPromptDocument(document, displayToken);

    expect(promptDocumentLogicalLength(document)).toBe(3);
    expect(projection.text).toBe("a$reviewb");
    expect(projection.logicalToDisplay(1)).toBe(1);
    expect(projection.logicalToDisplay(2)).toBe(8);
  });

  it("projects file, image, and paste tokens without flattening their payloads", () => {
    const document = [
      { type: "token" as const, kind: "file" as const, attachmentId: "file-1" },
      { type: "text" as const, text: " " },
      { type: "token" as const, kind: "image" as const, attachmentId: "image-1" },
      { type: "text" as const, text: " " },
      { type: "token" as const, kind: "paste" as const, text: "one\ntwo\nthree" },
    ];
    const projection = projectPromptDocument(document, (token) => {
      if (token.kind === "file") return "@src/main.ts";
      if (token.kind === "image") return "[Image #1]";
      return "$unused";
    });

    expect(projection.text).toBe("@src/main.ts [Image #1] $unused");
    expect(promptDocumentLogicalLength(document)).toBe(5);
    expect(promptTokens(document, "paste")[0]?.text).toBe("one\ntwo\nthree");
    expect(projection.tokenSpans).toHaveLength(3);
  });

  it("snaps display offsets inside a token to a requested logical edge", () => {
    const document = replacePromptRange(textPromptDocument("ab"), 1, 1, [skill]);
    const projection = projectPromptDocument(document, displayToken);

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
    const projection = projectPromptDocument(document, displayToken);

    expect(projectedDisplayRuns(projection.text, 0, projection.tokenSpans)).toEqual([
      { text: "a" },
      { text: "$review", token: skill },
      { text: "b" },
    ]);
  });
});
