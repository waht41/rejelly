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

  it("injects instructions while keeping the user-facing display clean", async () => {
    const message = await buildSkillAwareUserMessage(
      {
        document: [
          { type: "token", kind: "skill", qualifiedName: "project:review" },
          { type: "text", text: " inspect this" },
        ],
        attachments: [],
      },
      snapshot([record("review")]),
    );

    expect(message.content).toContain("<explicit_skills");
    expect(getUserInputDisplay(message)).toEqual({
      text: "$project:review inspect this",
      attachments: [],
    });
  });

  it("does not infer ordinary dollar-prefixed text", async () => {
    const message = await buildSkillAwareUserMessage(
      textPromptInput("echo $HOME and $project:review"),
      snapshot([record("review")]),
    );
    expect(message.content).toBe("echo $HOME and $project:review");
  });
});
