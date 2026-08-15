import { describe, expect, it } from "vitest";
import { parseFrozenUserInputV1 } from "./frozenUserInput";

describe("FrozenUserInputV1 codec", () => {
  it("accepts one self-contained resolved record", () => {
    expect(
      parseFrozenUserInputV1({
        version: 1,
        kind: "resolved",
        nodes: [
          { kind: "text", text: "review " },
          {
            kind: "file",
            path: "src/a.ts",
            action: "read",
            status: "resolved",
            context: "frozen body",
          },
        ],
      }),
    ).toMatchObject({ kind: "resolved", nodes: [{ kind: "text" }, { kind: "file" }] });
  });

  it("rejects a resolved Skill without its frozen context", () => {
    expect(() =>
      parseFrozenUserInputV1({
        version: 1,
        kind: "resolved",
        nodes: [{ kind: "skill", qualifiedName: "project:review", status: "resolved" }],
      }),
    ).toThrow();
  });
});
