import { describe, expect, it } from "vitest";
import { memoryTokensFromDocument, skillTokensFromDocument } from "./referenceTokens";

describe("semantic reference tokens", () => {
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

  it("deduplicates selected Memory tokens by stable id", () => {
    const token = {
      type: "token" as const,
      kind: "memory" as const,
      memoryId: "mem_afe761ca-6383-43e6-8429-445362848d0c",
    };
    expect(memoryTokensFromDocument([token, { type: "text", text: " x " }, token])).toEqual([
      token,
    ]);
  });
});
