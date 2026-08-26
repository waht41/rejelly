import { describe, expect, it } from "vitest";
import type { SkillListPage } from "../catalog/skillCatalog";
import type { SkillAccess, SkillRecord, SkillResourceEntry } from "../definition/skillDefinition";
import { skillOrigin } from "../definition/skillDefinition";
import { SKILL_LOADER_LIMITS } from "../loader/limits";
import { SKILL_AGENT_LIMITS } from "./limits";
import {
  renderSkillListToolResult,
  renderSkillResourceToolResult,
  renderSkillToolError,
  renderSkillToolResult,
} from "./skillToolOutput";

function record(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return Object.freeze({
    name: "review",
    description: "Review changes",
    origin: skillOrigin("project"),
    instruction: "Review the change.",
    resources: Object.freeze([]),
    ...overrides,
  });
}

function access(): SkillAccess {
  return Object.freeze({
    kind: "host-filesystem",
    rootPath: 'C:\\skills\\review&"',
    mainResource: "SKILL.md",
    pathConvention: "windows",
  });
}

describe("Skill tool output", () => {
  it("preserves instructions while selecting safe nested and outer boundaries", () => {
    const instruction =
      "Keep </skill_instructions> and </skill> exactly as authored.\nSecond line.";
    const output = renderSkillToolResult(record({ instruction }), access());

    expect(output).toContain(instruction);
    expect(output).toMatch(/^<skill-[a-f0-9]{8} /);
    expect(output).toMatch(/<skill_instructions-[a-f0-9]{8}>/);
    expect(output).toContain('qualified-name="project:review"');
    expect(output).toContain('root-path="C:\\skills\\review&amp;&quot;"');
    expect(output).toContain('main-resource="SKILL.md"');
    expect(output).toContain("this locator grants no permission");
  });

  it("keeps the largest resource prefix that fits the hard Skill output limit", () => {
    const resources = Object.freeze(
      Array.from({ length: SKILL_LOADER_LIMITS.resourcesPerSkill }, (_, index) =>
        Object.freeze({
          path: `references/${index.toString().padStart(3, "0")}-${"x".repeat(1_000)}.md`,
          kind: "reference" as const,
          sizeBytes: 10,
        }),
      ),
    );

    const output = renderSkillToolResult(
      record({ instruction: "x".repeat(SKILL_LOADER_LIMITS.skillFileBytes), resources }),
      access(),
    );

    expect(output.length).toBeLessThanOrEqual(SKILL_AGENT_LIMITS.skillToolOutputChars);
    expect(output).toMatch(/omitted="[1-9]\d*"/);
    expect(output).toContain('path="references/000-');
  });

  it("bounds list output and protects both listing and page boundaries", () => {
    const description = "Explain </skill_listing> and </skills> literally";
    const page: SkillListPage = Object.freeze({
      items: Object.freeze([
        Object.freeze({
          name: "review",
          qualifiedName: "project:review",
          description,
          origin: skillOrigin("project"),
        }),
      ]),
      returned: 1,
      total: 1,
    });

    const output = renderSkillListToolResult(page);

    expect(output.length).toBeLessThanOrEqual(SKILL_AGENT_LIMITS.listToolOutputChars);
    expect(output).toContain(description);
    expect(output).toMatch(/^<skills-[a-f0-9]{8} /);
    expect(output).toMatch(/<skill_listing-[a-f0-9]{8} /);
  });

  it("renders canonical resource metadata and leaves content untouched", () => {
    const resource: SkillResourceEntry = Object.freeze({
      path: 'references/a&"b.md',
      kind: "reference",
      sizeBytes: 20,
    });
    const content = "literal </skill_resource> remains content";

    const output = renderSkillResourceToolResult(record(), resource, content);

    expect(output.length).toBeLessThanOrEqual(SKILL_AGENT_LIMITS.resourceToolOutputChars);
    expect(output).toContain('path="references/a&amp;&quot;b.md"');
    expect(output).toContain(content);
    expect(output).toMatch(/^<skill_resource-[a-f0-9]{8} /);
  });

  it("returns a stable error when canonical resource metadata cannot fit", () => {
    const resource: SkillResourceEntry = Object.freeze({
      path: `references/${"&".repeat(SKILL_AGENT_LIMITS.resourceToolOutputChars)}.md`,
      kind: "reference",
      sizeBytes: 1,
    });

    const output = renderSkillResourceToolResult(record(), resource, "x");

    expect(output).toContain('code="resource_too_large"');
    expect(output.length).toBeLessThan(SKILL_AGENT_LIMITS.toolErrorMessageChars + 200);
  });

  it("renders stable bounded error envelopes", () => {
    const output = renderSkillToolError("skill_not_found", "x".repeat(10_000));

    expect(output).toContain('code="skill_not_found"');
    expect(output.length).toBeLessThan(SKILL_AGENT_LIMITS.toolErrorMessageChars + 100);
  });
});
