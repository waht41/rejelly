import { Lang, parse } from "@ast-grep/napi";
import { describe, expect, it } from "vitest";
import { extractLeadingFileJsDoc } from "../domains/workspace/ast/jsdoc";
import {
  collectDocumentSymbols,
  extractExternalCalleeSymbols,
  filterDeclarationsByName,
  findCallableDeclarationForSymbol,
  findNamedDeclarationAstNodes,
  getCallableEnvelope,
  sliceDeclarationSignature,
} from "../domains/workspace/ast/queries";
import { escapeRegexLiteral } from "../shared/foundation/string";

describe("heuristicAstCore", () => {
  it("escapeRegexLiteral escapes metacharacters", () => {
    expect(escapeRegexLiteral("a+b")).toBe("a\\+b");
    expect(escapeRegexLiteral("foo.bar")).toBe("foo\\.bar");
  });

  it("collectDocumentSymbols captures declarations", () => {
    const code = `
      class C {}
      function f() {}
      const x = 1;
      const { y } = z;
    `;
    const root = parse(Lang.TypeScript, code).root();
    const syms = collectDocumentSymbols(root, Lang.TypeScript);
    const names = syms.map((s) => `${s.kind}:${s.name}`);
    expect(names).toContain("class:C");
    expect(names).toContain("function:f");
    expect(names).toContain("variable:x");
    expect(names.some((n) => n.includes("y"))).toBe(false);
  });

  it("collectDocumentSymbols skips locals inside arrows and nested functions", () => {
    const code = `
      export const Agent = createAgent({
        handler: async () => {
          const worldOrMsg = 1;
          function inner() {}
          const nested = 2;
        },
      });
    `;
    const root = parse(Lang.TypeScript, code).root();
    const syms = collectDocumentSymbols(root, Lang.TypeScript);
    const names = syms.map((s) => `${s.kind}:${s.name}`);
    expect(names).toEqual(["variable:Agent"]);
    expect(names.some((n) => n.includes("worldOrMsg"))).toBe(false);
    expect(names.some((n) => n.includes("inner"))).toBe(false);
    expect(names.some((n) => n.includes("nested"))).toBe(false);
  });

  it("collectDocumentSymbols keeps class methods but not object literal methods", () => {
    const code = `
      class Box {
        run() {
          const hidden = 1;
        }
      }
      const o = {
        m() {
          const insideObj = 2;
        },
      };
    `;
    const root = parse(Lang.TypeScript, code).root();
    const syms = collectDocumentSymbols(root, Lang.TypeScript);
    const names = syms.map((s) => `${s.kind}:${s.name}`);
    expect(names).toContain("class:Box");
    expect(names).toContain("method:run");
    expect(names).toContain("variable:o");
    expect(names.some((n) => n.includes("hidden"))).toBe(false);
    expect(names.some((n) => n.includes("insideObj"))).toBe(false);
    expect(names).not.toContain("method:m");
  });

  it("findNamedDeclarationAstNodes returns nested declarations and node.text()", () => {
    const code = `
      function processSyncTask() {
        return 0;
      }
      function outer() {
        function processSyncTask() {
          return 1;
        }
        return processSyncTask;
      }
    `;
    const root = parse(Lang.TypeScript, code).root();
    const nodes = findNamedDeclarationAstNodes(root, "processSyncTask", false, Lang.TypeScript);
    expect(nodes.length).toBe(2);
    expect(nodes[0]?.kind()).toBe("function_declaration");
    expect(nodes[0]?.text()).toContain("return 0");
    expect(nodes[1]?.kind()).toBe("function_declaration");
    expect(nodes[1]?.text()).toContain("return 1");
  });

  it("extractLeadingFileJsDoc reads top-of-file block", () => {
    const lines = [
      "/**",
      " * Module overview line.",
      " */",
      "",
      'import "./x";',
      "export const a = 1;",
    ];
    const raw = extractLeadingFileJsDoc(lines);
    expect(raw).toContain("Module overview line.");
  });

  it("filterDeclarationsByName respects case flag", () => {
    const rows = [
      { kind: "function" as const, name: "Foo", line: 1 },
      { kind: "function" as const, name: "foo", line: 2 },
    ];
    expect(filterDeclarationsByName(rows, "Foo", false)).toHaveLength(1);
    expect(filterDeclarationsByName(rows, "foo", true)).toHaveLength(2);
  });

  it("extractExternalCalleeSymbols lists non-local callees only", () => {
    const code = `
      function outer() {
        const helper = () => sink();
        helper();
        externalFn();
      }
    `;
    const root = parse(Lang.TypeScript, code).root();
    const fd = findCallableDeclarationForSymbol(root, "outer", false);
    expect(fd).toBeTruthy();
    const env = getCallableEnvelope(fd!);
    const body = env!.field("body")!;
    const syms = extractExternalCalleeSymbols(body, Lang.TypeScript);
    expect(syms).toContain("externalFn");
    expect(syms).not.toContain("helper");
  });

  it("collectDocumentSymbols works on plain JavaScript parses (TS-only kinds skipped, no throw)", () => {
    const code = `
      class C {}
      function f(a, b = 1) {}
      const x = () => {};
    `;
    const root = parse(Lang.JavaScript, code).root();
    const syms = collectDocumentSymbols(root, Lang.JavaScript);
    const names = syms.map((s) => `${s.kind}:${s.name}`);
    expect(names).toContain("class:C");
    expect(names).toContain("function:f");
    expect(names).toContain("variable:x");
  });

  it("findNamedDeclarationAstNodes works on plain JavaScript parses", () => {
    const code = `
      function target() { return 1; }
      const other = 2;
    `;
    const root = parse(Lang.JavaScript, code).root();
    const nodes = findNamedDeclarationAstNodes(root, "target", false, Lang.JavaScript);
    expect(nodes.length).toBe(1);
    expect(nodes[0]?.kind()).toBe("function_declaration");
  });

  it("extractExternalCalleeSymbols binds JS parameters without TS parameter kinds", () => {
    const code = `
      function outer(cb) {
        cb();
        externalFn();
      }
    `;
    const root = parse(Lang.JavaScript, code).root();
    const fd = findCallableDeclarationForSymbol(root, "outer", false);
    expect(fd).toBeTruthy();
    const env = getCallableEnvelope(fd!);
    const body = env!.field("body")!;
    const syms = extractExternalCalleeSymbols(body, Lang.JavaScript);
    expect(syms).toContain("externalFn");
    expect(syms).not.toContain("cb");
  });

  it("sliceDeclarationSignature omits function body text", () => {
    const code = "function demo(a: number): void {\n  return;\n}";
    const root = parse(Lang.TypeScript, code).root();
    const fd = root.findAll({ rule: { kind: "function_declaration" } })[0]!;
    const sig = sliceDeclarationSignature(code, fd);
    expect(sig).toContain("function demo");
    expect(sig).not.toContain("return");
  });
});
