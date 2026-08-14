import { describe, expect, it, vi } from "vitest";
import type { SkillRuntimeSnapshot } from "../../../domains/skills/agent/skillRuntime";
import { createSkillCatalog } from "../../../domains/skills/catalog/skillCatalog";
import type { SkillRecord } from "../../../domains/skills/definition/skillDefinition";
import { skillOrigin } from "../../../domains/skills/definition/skillDefinition";
import { getUserInputDisplay } from "../../../shared/model/message/userInputMetadata";
import { textPromptInput } from "../../../shared/model/prompt/promptInput";
import {
  buildSkillAwareUserMessage,
  renderExplicitSkillContext,
  resolveExplicitSkills,
} from "./skillAwareUserMessage";

function record(name: string, scope: "user" | "project" = "project"): SkillRecord {
  return Object.freeze({
    name,
    description: `${name} description`,
    origin: skillOrigin(scope),
    instruction: `Follow the ${name} workflow.`,
    resources: Object.freeze([]),
  });
}

function snapshot(records: readonly SkillRecord[]): SkillRuntimeSnapshot {
  return Object.freeze({
    catalog: createSkillCatalog(records),
    resources: { readText: vi.fn() },
  });
}

describe("explicit Skill references", () => {
  it("resolves qualified structured selections, preserves order, and de-duplicates", () => {
    const review = record("review");
    const test = record("test", "user");
    const runtime = snapshot([review, test]);

    expect(
      resolveExplicitSkills(runtime, ["user:test", "project:review", "user:test", "missing"]),
    ).toEqual([test, review]);
  });

  it("renders selected instructions inside an explicit wrapper", () => {
    const output = renderExplicitSkillContext([record("review")]);
    expect(output).toContain('<explicit_skills count="1">');
    expect(output).toContain('qualified-name="project:review"');
    expect(output).toContain("Follow the review workflow.");
  });

  it("keeps the marker in place and appends instructions after the intact user request", async () => {
    const message = await buildSkillAwareUserMessage(
      {
        document: [
          { type: "text", text: "Please " },
          { type: "token", kind: "skill", qualifiedName: "project:review" },
          { type: "text", text: " inspect this." },
        ],
        attachments: [],
      },
      snapshot([record("review")]),
    );
    const content = message.content as string;

    expect(content).toMatch(
      /^Please \$project:review inspect this\.\n\n<explicit_skills count="1">/,
    );
    expect(content.indexOf("inspect this.")).toBeLessThan(
      content.indexOf("Follow the review workflow."),
    );
    expect(getUserInputDisplay(message)).toEqual({
      text: "Please $project:review inspect this.",
      attachments: [],
    });
  });

  it("appends multiple Skill instructions once in first-token order", async () => {
    const message = await buildSkillAwareUserMessage(
      {
        document: [
          { type: "token", kind: "skill", qualifiedName: "user:test" },
          { type: "text", text: " then " },
          { type: "token", kind: "skill", qualifiedName: "project:review" },
          { type: "text", text: " and again " },
          { type: "token", kind: "skill", qualifiedName: "user:test" },
        ],
        attachments: [],
      },
      snapshot([record("review"), record("test", "user")]),
    );
    const content = message.content as string;

    expect(content).toContain(
      '$user:test then $project:review and again $user:test\n\n<explicit_skills count="2">',
    );
    expect(content.indexOf("Follow the test workflow.")).toBeLessThan(
      content.indexOf("Follow the review workflow."),
    );
    expect(content.match(/Follow the test workflow\./g)).toHaveLength(1);
  });

  it("does not infer ordinary dollar-prefixed text", async () => {
    const message = await buildSkillAwareUserMessage(
      textPromptInput("echo $HOME and $project:review"),
      snapshot([record("review")]),
    );
    expect(message.content).toBe("echo $HOME and $project:review");
  });
});
