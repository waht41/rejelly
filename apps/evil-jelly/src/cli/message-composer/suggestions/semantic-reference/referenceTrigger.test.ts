import { describe, expect, it } from "vitest";
import {
  activeReferenceTrigger,
  extractReferenceQuery,
  removeActiveReferenceTrigger,
} from "./referenceTrigger";

describe("semantic reference $ trigger", () => {
  it("extracts a lowercase query at a token boundary", () => {
    expect(extractReferenceQuery("use $pro", 8)).toBe("pro");
    expect(extractReferenceQuery("$project:review", 15)).toBe("project:review");
    expect(extractReferenceQuery("cost$review", 11)).toBeNull();
  });

  it("does not treat environment-variable syntax as a reference query", () => {
    expect(extractReferenceQuery("echo $HOME", 10)).toBeNull();
    expect(extractReferenceQuery("echo $" + "{HOME}", 12)).toBeNull();
    expect(extractReferenceQuery("echo $env:PATH", 14)).toBeNull();
  });

  it("accepts lowercase Unicode search terms", () => {
    const text = "use $提交信息";
    expect(extractReferenceQuery(text, text.length)).toBe("提交信息");
  });

  it("returns the active trigger display range", () => {
    expect(activeReferenceTrigger("use $rev", 8)).toEqual({ start: 4, end: 8, query: "rev" });
  });

  it("finds an active trigger on a later multiline row", () => {
    const text = "first\nsecond\n$rev";

    expect(activeReferenceTrigger(text, text.length)).toEqual({
      start: text.lastIndexOf("$"),
      end: text.length,
      query: "rev",
    });
  });

  it("removes an unfinished text trigger without creating a fake reference token", () => {
    expect(removeActiveReferenceTrigger({ text: "use $rev", cursor: 8 })).toEqual({
      text: "use ",
      cursor: 4,
    });
  });
});
