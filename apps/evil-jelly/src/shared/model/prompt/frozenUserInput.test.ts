import type { Message } from "@rejelly/core";
import { describe, expect, it } from "vitest";
import {
  copyFrozenUserInputOrigin,
  type FrozenResolvedUserInputV1,
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
  ],
};

describe("frozen user input projections", () => {
  it("derives display and model content from one frozen record", () => {
    expect(projectFrozenUserInputDisplay(input)).toMatchObject({
      text: "review $project:review@src/a.ts",
      attachments: [{ type: "file", label: "src/a.ts", action: "read" }],
    });
    expect(projectFrozenUserInputMessage(input).content).toContain('<explicit_skills count="1">');
  });

  it("copies only the canonical origin association between Message projections", () => {
    const source = registerFrozenUserInputOrigin<Message>({ role: "user", content: "x" }, input);
    const target = copyFrozenUserInputOrigin(source, { ...source });
    expect(getFrozenUserInputOrigin(target)).toBe(input);
    expect(target.extra).toBeUndefined();
  });
});
