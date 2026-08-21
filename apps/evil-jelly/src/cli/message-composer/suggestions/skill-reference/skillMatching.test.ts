import { describe, expect, it } from "vitest";
import { filterPromptReferencePickerItems } from "./skillMatching";

const skill = {
  qualifiedName: "project:review",
  name: "review",
  scope: "project" as const,
  description: "Review changes",
};

describe("shared $ reference matching", () => {
  it("returns typed Skill and MCP candidates from one query", () => {
    expect(filterPromptReferencePickerItems([skill], [{ serverId: "docs" }], "")).toEqual([
      { kind: "skill", skill },
      { kind: "mcp", server: { serverId: "docs" } },
    ]);
    expect(filterPromptReferencePickerItems([skill], [{ serverId: "docs" }], "mcp:doc")).toEqual([
      { kind: "mcp", server: { serverId: "docs" } },
    ]);
  });
});
