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

  it("requires selected Memory content to be self-contained when resolved", () => {
    const memory = {
      kind: "memory",
      memoryId: "mem_afe761ca-6383-43e6-8429-445362848d0c",
      status: "resolved",
      scope: "project",
      revision: 1,
      title: "Title",
      summary: "Summary",
      detail: "Detail",
    };
    expect(parseFrozenUserInputV1({ version: 1, kind: "resolved", nodes: [memory] })).toMatchObject(
      { nodes: [memory] },
    );
    expect(() =>
      parseFrozenUserInputV1({
        version: 1,
        kind: "resolved",
        nodes: [{ ...memory, detail: undefined }],
      }),
    ).toThrow();
  });
});
