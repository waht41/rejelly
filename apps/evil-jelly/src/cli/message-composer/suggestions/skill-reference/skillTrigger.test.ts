import { describe, expect, it } from "vitest";
import type { UserSkillListItem } from "../../../../shared/host/inputBindings";
import {
  activeSkillTrigger,
  extractSkillQuery,
  mcpReferenceName,
  removeActiveSkillTrigger,
  skillReferenceName,
  skillTokensFromDocument,
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
    expect(skillReferenceName(catalog[0]!, catalog, [{ serverId: "review" }])).toBe(
      "project:review",
    );
    expect(mcpReferenceName({ serverId: "docs" }, catalog)).toBe("docs");
    expect(mcpReferenceName({ serverId: "review" }, catalog)).toBe("mcp:review");
  });

  it("removes an unfinished text trigger without creating a fake Skill marker", () => {
    expect(removeActiveSkillTrigger({ text: "use $rev", cursor: 8 })).toEqual({
      text: "use ",
      cursor: 4,
    });
  });

  it("derives unique selected Skill tokens directly from the document", () => {
    const token = {
      type: "token" as const,
      kind: "skill" as const,
      qualifiedName: "project:review",
    };
    expect(skillTokensFromDocument([token, { type: "text", text: " $HOME " }, token])).toEqual([
      token,
    ]);
  });
});
