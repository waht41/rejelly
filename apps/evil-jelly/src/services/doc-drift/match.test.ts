import { describe, expect, it } from "vitest";
import type { MatchableSymbol } from "./match";
import { buildSymbolTable, extractSectionMentions, matchSectionSymbols } from "./match";
import { splitMarkdownH2Sections } from "./sections";

function symbol(name: string, file = "src/api.ts", line = 1): MatchableSymbol {
  return { name, kind: "function", file, line, signature: `export function ${name}()` };
}

const MD = [
  "## `createAgent(config)`",
  "Call `promptAgent` after setup. The `props.task` field is free-form.",
  "```ts",
  "const agent = createAgent({ id: 'x' });",
  "await runWith(() => agent({}), {});",
  "```",
  "See also `equipSystem`.",
].join("\n");

describe("extractSectionMentions", () => {
  const section = splitMarkdownH2Sections(MD)[0];
  const mentions = extractSectionMentions(section);

  it("takes heading and inline-span identifiers as primary", () => {
    expect(mentions.primary).toContain("createAgent");
    expect(mentions.primary).toContain("promptAgent");
    expect(mentions.primary).toContain("equipSystem");
  });

  it("takes fenced example identifiers as secondary only", () => {
    expect(mentions.secondary).toContain("runWith");
    expect(mentions.primary).not.toContain("runWith");
  });

  it("drops short noise tokens", () => {
    expect(mentions.secondary).not.toContain("id");
  });
});

describe("matchSectionSymbols", () => {
  const section = splitMarkdownH2Sections(MD)[0];

  it("matches primary and secondary mentions, reports only primary misses", () => {
    const table = buildSymbolTable([
      symbol("createAgent"),
      symbol("promptAgent"),
      symbol("runWith"),
    ]);
    const result = matchSectionSymbols(section, table);
    expect(result.matched.map((s) => s.name)).toEqual(
      expect.arrayContaining(["createAgent", "promptAgent", "runWith"]),
    );
    // equipSystem and props/task are unmatched, but fenced-only identifiers never appear.
    expect(result.unmatched).toContain("equipSystem");
    expect(result.unmatched).toContain("props");
    expect(result.unmatched).not.toContain("agent");
  });

  it("dedupes symbols mentioned in several forms", () => {
    const table = buildSymbolTable([symbol("createAgent")]);
    const result = matchSectionSymbols(section, table);
    expect(result.matched.filter((s) => s.name === "createAgent")).toHaveLength(1);
  });
});
