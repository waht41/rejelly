import { describe, expect, it } from "vitest";
import { extractLeadingFileJsDoc } from "./jsdoc";

describe("workspace AST JSDoc", () => {
  it("extracts a leading file-level JSDoc block", () => {
    const lines = [
      "/**",
      " * Module overview line.",
      " */",
      "",
      'import "./x";',
      "export const a = 1;",
    ];

    expect(extractLeadingFileJsDoc(lines)).toContain("Module overview line.");
  });
});
