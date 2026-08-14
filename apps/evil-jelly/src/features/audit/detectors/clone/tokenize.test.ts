import { Lang, parse } from "@ast-grep/napi";
import { describe, expect, it } from "vitest";
import { tokenizeNormalized } from "./tokenize";

function tokensOf(code: string): string[] {
  return tokenizeNormalized(parse(Lang.TypeScript, code).root()).map((t) => t.norm);
}

describe("tokenizeNormalized", () => {
  it("collapses renamed identifiers and literals so Type-2 clones match", () => {
    const a = `const total = orders.reduce((s, o) => s + o.amount, 0);`;
    const b = `const sum = records.reduce((acc, r) => acc + r.value, 1);`;
    expect(tokensOf(a)).toEqual(tokensOf(b));
  });

  it("keeps keywords and punctuation verbatim", () => {
    const toks = tokensOf(`if (x) { return 1; }`);
    expect(toks).toContain("if");
    expect(toks).toContain("return");
    expect(toks).toContain("{");
    expect(toks).toContain("$ID");
    expect(toks).toContain("$LIT");
  });

  it("drops comments and treats strings/templates atomically", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source fixture, not interpolation
    const toks = tokensOf("// a comment\nconst s = `hello ${name}`;");
    expect(toks).not.toContain("//");
    // The whole template is one $LIT token, not its inner pieces.
    expect(toks.filter((t) => t === "$LIT").length).toBe(1);
  });

  it("carries 1-based line numbers", () => {
    const tokens = tokenizeNormalized(parse(Lang.TypeScript, "const x = 1;\nconst y = 2;").root());
    expect(tokens[0].line).toBe(1);
    expect(tokens[tokens.length - 1].line).toBe(2);
  });
});
