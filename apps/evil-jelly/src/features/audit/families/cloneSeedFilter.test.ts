import { Lang, parse } from "@ast-grep/napi";
import { describe, expect, it } from "vitest";
import type { CloneFragment } from "../../../services/clone";
import { analyzeFileBehavior, classifyFragment } from "./cloneSeedFilter";

/** Classify a whole snippet (fragment = its full line span). */
function classify(code: string, lang: Lang = Lang.TypeScript): "declaration" | "code" {
  const trimmed = code.replace(/^\n/, "");
  const root = parse(lang, trimmed).root();
  const fb = analyzeFileBehavior(root);
  const lineCount = trimmed.split("\n").length;
  const fragment: CloneFragment = {
    file: "x.ts",
    startLine: 1,
    endLine: lineCount,
    lines: lineCount,
  };
  return classifyFragment(fb, fragment);
}

describe("classifyFragment — droppable declarations", () => {
  it("interface declaration", () => {
    expect(classify(`interface Foo { a: number; b: string; }`)).toBe("declaration");
  });

  it("type alias", () => {
    expect(classify(`type Foo = { a: number; b: string };`)).toBe("declaration");
  });

  it("enum", () => {
    expect(classify(`enum Color { Red, Green, Blue }`)).toBe("declaration");
  });

  it("plain object literal const", () => {
    expect(classify(`const cfg = { mode: "a", retries: 3, nested: { x: 1 } };`)).toBe(
      "declaration",
    );
  });

  it("array literal const", () => {
    expect(classify(`const list = ["a", "b", "c"];`)).toBe("declaration");
  });

  it("zod schema builder chain with object arg", () => {
    expect(
      classify(`const S = z.object({ name: z.string().describe("the name"), n: z.number() });`),
    ).toBe("declaration");
  });

  it("tool-definition object head without the handler body in range", () => {
    expect(
      classify(`const Tool = { name: "grep", description: "search", parameters: schema };`),
    ).toBe("declaration");
  });
});

describe("classifyFragment — kept code (whitelist safety net)", () => {
  it("arrow-function initializer (e.g. normalizeNewlines)", () => {
    expect(classify(`const f = (s) => s.replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n");`)).toBe(
      "code",
    );
  });

  it("ternary initializer (e.g. error-handling idiom)", () => {
    expect(classify(`const msg = e instanceof Error ? e.message : String(e);`)).toBe("code");
  });

  it("schema with a refine callback in range", () => {
    expect(classify(`const S = z.string().refine((v) => v.length > 0, "required");`)).toBe("code");
  });

  it("config object with a function-valued property in range", () => {
    expect(classify(`const Tool = { name: "x", handler: async () => { return doWork(); } };`)).toBe(
      "code",
    );
  });

  it("Set-dedup idiom (control flow)", () => {
    expect(
      classify(`
const seen = new Set();
const out = [];
for (const item of items) {
  if (!seen.has(item)) {
    seen.add(item);
    out.push(item);
  }
}`),
    ).toBe("code");
  });

  it("bare side-effecting call sequence", () => {
    expect(
      classify(`
doFirst();
doSecond();
doThird();`),
    ).toBe("code");
  });

  it("function declaration", () => {
    expect(classify(`function add(a, b) { return a + b; }`)).toBe("code");
  });
});

describe("analyzeFileBehavior — multi-construct ranges", () => {
  it("keeps a range that mixes a type decl with real logic", () => {
    const code = `
type Args = { n: number };
function run(a: Args) {
  if (a.n > 0) {
    return a.n;
  }
  return 0;
}`.replace(/^\n/, "");
    const root = parse(Lang.TypeScript, code).root();
    const fb = analyzeFileBehavior(root);
    const frag: CloneFragment = { file: "x.ts", startLine: 1, endLine: 7, lines: 7 };
    expect(classifyFragment(fb, frag)).toBe("code");
  });
});
