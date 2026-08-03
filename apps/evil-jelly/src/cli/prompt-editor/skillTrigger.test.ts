import { describe, expect, it } from "vitest";
import { extractSkillQuery, replaceSkillToken, skillReferencesPresentInText } from "./skillTrigger";

describe("Skill $ trigger", () => {
  it("extracts a lowercase query at a token boundary", () => {
    expect(extractSkillQuery("use $pro", 8)).toBe("pro");
    expect(extractSkillQuery("$project:review", 15)).toBe("project:review");
    expect(extractSkillQuery("cost$review", 11)).toBeNull();
  });

  it("does not treat environment-variable syntax as a Skill query", () => {
    expect(extractSkillQuery("echo $HOME", 10)).toBeNull();
    expect(extractSkillQuery("echo $" + "{HOME}", 12)).toBeNull();
    expect(extractSkillQuery("echo $env:PATH", 14)).toBeNull();
  });

  it("replaces the active token with a visible qualified marker", () => {
    expect(replaceSkillToken({ text: "use $rev", cursor: 8 }, ["project:review"])).toEqual({
      text: "use $project:review ",
      cursor: 20,
    });
  });

  it("reconciles only references that were already selected", () => {
    const selected = [{ qualifiedName: "project:review" }, { qualifiedName: "user:test" }];
    expect(
      skillReferencesPresentInText("$project:review inspect $HOME and $unknown", selected),
    ).toEqual([{ qualifiedName: "project:review" }]);
    expect(skillReferencesPresentInText("$project:reviewer", selected)).toEqual([]);
  });
});
