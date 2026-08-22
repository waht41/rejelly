import { describe, expect, it } from "vitest";
import type { UserSkillListItem } from "../../../../shared/host/inputBindings";
import { mcpReferenceName, memoryReferenceName, skillReferenceName } from "./referenceNaming";

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

describe("semantic reference naming", () => {
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

  it("names Memory references by title and disambiguates collisions", () => {
    const token = {
      memoryId: "mem_afe761ca-6383-43e6-8429-445362848d0c",
    };
    const memories = [
      {
        id: token.memoryId,
        scope: "project" as const,
        title: "Squash message",
        summary: "Summary",
      },
    ];
    expect(memoryReferenceName(token, memories)).toBe("Squash message");
    expect(
      memoryReferenceName(token, [
        ...memories,
        {
          ...memories[0]!,
          id: "mem_bfe761ca-6383-43e6-8429-445362848d0d",
          scope: "user",
        },
      ]),
    ).toBe("project:Squash message");
    expect(memoryReferenceName(token, memories, [{ ...catalog[0]!, name: "Squash message" }])).toBe(
      "memory:Squash message",
    );
  });
});
