import { describe, expect, it } from "vitest";
import { filterPromptReferencePickerItems } from "./skillMatching";

const skill = {
  qualifiedName: "project:review",
  name: "review",
  scope: "project" as const,
  description: "Review changes",
};
const memory = {
  id: "mem_afe761ca-6383-43e6-8429-445362848d0c",
  scope: "project" as const,
  title: "Squash message",
  summary: "Use the PR description as the squash commit message.",
};

describe("shared $ reference matching", () => {
  it("returns typed Skill and MCP candidates from one query", () => {
    expect(filterPromptReferencePickerItems([skill], [{ serverId: "docs" }], [memory], "")).toEqual(
      [
        { kind: "skill", skill },
        { kind: "mcp", server: { serverId: "docs" } },
        { kind: "memory", memory },
      ],
    );
    expect(
      filterPromptReferencePickerItems([skill], [{ serverId: "docs" }], [memory], "mcp:doc"),
    ).toEqual([{ kind: "mcp", server: { serverId: "docs" } }]);
    expect(
      filterPromptReferencePickerItems([skill], [{ serverId: "docs" }], [memory], "squash"),
    ).toEqual([{ kind: "memory", memory }]);
  });
});
