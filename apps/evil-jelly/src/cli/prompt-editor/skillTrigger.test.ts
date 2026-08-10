import { describe, expect, it } from "vitest";
import type { UserSkillListItem } from "../../shared/AgentShared";
import { projectPromptDocument } from "./promptDocument";
import {
  activeSkillTrigger,
  extractSkillQuery,
  hydrateSkillTokens,
  replaceSkillToken,
  skillReferenceName,
  skillReferencesFromDocument,
  skillReferencesPresentInText,
} from "./skillTrigger";

const catalog: UserSkillListItem[] = [
  {
    qualifiedName: "project:review",
    name: "review",
    scope: "project",
    description: "Project review",
  },
  {
    qualifiedName: "user:test",
    name: "test",
    scope: "user",
    description: "Personal test",
  },
];

describe("Skill $ trigger", () => {
  it("extracts a lowercase query at a token boundary", () => {
    expect(extractSkillQuery("use $pro", 8)).toBe("pro");
    expect(extractSkillQuery("$project:review", 15)).toBe("project:review");
    expect(extractSkillQuery("cost$review", 11)).toBeNull();
  });

  it("does not treat environment-variable syntax as a Skill query", () => {
    expect(extractSkillQuery("echo $HOME", 10)).toBeNull();
    expect(extractSkillQuery("echo $" + "{HOME}", 12)).toBeNull();
    expect(extractSkillQuery("echo $env:PATH", 14)).toBeNull();
  });

  it("returns the active trigger display range", () => {
    expect(activeSkillTrigger("use $rev", 8)).toEqual({ start: 4, end: 8, query: "rev" });
  });

  it("finds an active trigger on a later multiline row", () => {
    const text = "first\nsecond\n$rev";

    expect(activeSkillTrigger(text, text.length)).toEqual({
      start: text.lastIndexOf("$"),
      end: text.length,
      query: "rev",
    });
  });

  it("qualifies a reference only when the complete catalog contains the same name", () => {
    expect(skillReferenceName(catalog[0]!, catalog)).toBe("review");
    const duplicate: UserSkillListItem = {
      ...catalog[0]!,
      qualifiedName: "user:review",
      scope: "user",
    };

    expect(skillReferenceName(catalog[0]!, [...catalog, duplicate])).toBe("project:review");
    expect(skillReferenceName(duplicate, [...catalog, duplicate])).toBe("user:review");
  });

  it("replaces the active token with a visible qualified marker", () => {
    expect(replaceSkillToken({ text: "use $rev", cursor: 8 }, ["project:review"])).toEqual({
      text: "use $project:review ",
      cursor: 20,
    });
  });

  it("reconciles only references that were already selected", () => {
    const selected = [{ qualifiedName: "project:review" }, { qualifiedName: "user:test" }];
    expect(
      skillReferencesPresentInText("$project:review inspect $HOME and $unknown", selected),
    ).toEqual([{ qualifiedName: "project:review" }]);
    expect(skillReferencesPresentInText("$project:reviewer", selected)).toEqual([]);
  });

  it("hydrates semantic tokens from a restored draft and canonical references", () => {
    let id = 0;
    const document = hydrateSkillTokens(
      "use $project:review now",
      [{ qualifiedName: "project:review" }],
      () => "review",
      () => `skill-${++id}`,
    );

    expect(projectPromptDocument(document).text).toBe("use $review now");
    expect(skillReferencesFromDocument(document)).toEqual([{ qualifiedName: "project:review" }]);
  });
});
