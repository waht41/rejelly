import type { Message } from "@rejelly/core";
import { describe, expect, it } from "vitest";
import {
  copyFrozenUserInputOrigin,
  type FrozenResolvedUserInputV1,
  frozenUserInputMcpServerIds,
  getFrozenUserInputOrigin,
  projectFrozenUserInputDisplay,
  projectFrozenUserInputMessage,
  registerFrozenUserInputOrigin,
} from "./frozenUserInput";

const input: FrozenResolvedUserInputV1 = {
  version: 1,
  kind: "resolved",
  nodes: [
    { kind: "text", text: "review " },
    { kind: "skill", qualifiedName: "project:review", status: "resolved", context: "skill" },
    {
      kind: "file",
      path: "src/a.ts",
      action: "read",
      status: "resolved",
      context: "<attached_file>body</attached_file>",
    },
    { kind: "mcp", serverId: "docs", status: "selected", configFingerprint: "config-1" },
    { kind: "mcp", serverId: "docs", status: "selected", configFingerprint: "config-1" },
    {
      kind: "memory",
      memoryId: "mem_afe761ca-6383-43e6-8429-445362848d0c",
      status: "resolved",
      scope: "project",
      revision: 2,
      title: "Squash message",
      summary: "Use PR description as the squash message.",
      detail: "Keep the PR description suitable for a final commit message.",
    },
  ],
};

describe("frozen user input projections", () => {
  it("derives display and model content from one frozen record", () => {
    expect(projectFrozenUserInputDisplay(input)).toMatchObject({
      text: "review $project:review@src/a.ts$mcp:docs$mcp:docs$memory:Squash message",
      attachments: [{ type: "file", label: "src/a.ts", action: "read" }],
    });
    expect(projectFrozenUserInputMessage(input).content).toContain('<explicit_skills count="1">');
    expect(projectFrozenUserInputMessage(input).content).toContain(
      '<selected_mcp server="docs" status="selected" />',
    );
    expect(projectFrozenUserInputMessage(input).content).toContain('<explicit_memories count="1">');
    expect(projectFrozenUserInputMessage(input).content).toContain(
      'id="mem_afe761ca-6383-43e6-8429-445362848d0c" scope="project" revision="2"',
    );
    expect(projectFrozenUserInputMessage(input).content).toContain(
      "Keep the PR description suitable for a final commit message.",
    );
    expect(frozenUserInputMcpServerIds(input)).toEqual(["docs"]);
  });

  it("copies only the canonical origin association between Message projections", () => {
    const source = registerFrozenUserInputOrigin<Message>({ role: "user", content: "x" }, input);
    const target = copyFrozenUserInputOrigin(source, { ...source });
    expect(getFrozenUserInputOrigin(target)).toBe(input);
    expect(target.extra).toBeUndefined();
  });
});
