import type { ToolDefinition } from "@rejelly/core";
import { z } from "zod";
import type { SkillResolveResult } from "../catalog/skillCatalog";
import type { SkillRuntimeSnapshot } from "./skillRuntime";
import {
  renderSkillListToolResult,
  renderSkillResourceToolResult,
  renderSkillToolError,
  renderSkillToolResult,
  type SkillToolErrorCode,
} from "./skillToolOutput";

const readSkillParameters = z.object({
  skill: z.string().describe("A plain Skill name, or a qualified name such as project:review."),
});

const listSkillsParameters = z.object({
  cursor: z.string().optional().describe("Opaque cursor returned by the previous page."),
});

const readSkillResourceParameters = z.object({
  skill: z.string().describe("A plain Skill name, or a qualified name such as project:review."),
  path: z.string().describe("A resource path listed by the selected Skill."),
});

function lookupError(result: Exclude<SkillResolveResult, { ok: true }>): string {
  if (result.reason === "ambiguous") {
    return renderSkillToolError(
      "skill_ambiguous",
      `The plain Skill name is ambiguous. Use one of: ${result.candidates.join(", ")}.`,
    );
  }
  const suggestion =
    result.candidates.length > 0 ? ` Similar Skills: ${result.candidates.join(", ")}.` : "";
  return renderSkillToolError("skill_not_found", `The requested Skill was not found.${suggestion}`);
}

const RESOURCE_ERROR_CODES = Object.freeze({
  "resource-not-listed": "resource_not_listed",
  "resource-escape": "resource_escape",
  "resource-missing": "resource_missing",
  "resource-too-large": "resource_too_large",
  "unsupported-binary-resource": "unsupported_binary_resource",
} satisfies Readonly<Record<string, SkillToolErrorCode>>);

export function createReadSkillTool(
  snapshot: SkillRuntimeSnapshot,
): ToolDefinition<typeof readSkillParameters> {
  return {
    name: "read_skill",
    description:
      "Load the complete instructions and bounded resource inventory for one available local Skill. " +
      "The activated Skill includes its host filesystem root for resolving bundled files; the " +
      "location does not grant tool permissions. Use a qualified name when a plain name is ambiguous.",
    parameters: readSkillParameters,
    handler: async ({ skill }) => {
      const resolved = snapshot.catalog.resolve(skill);
      return resolved.ok
        ? renderSkillToolResult(resolved.skill, snapshot.access.get(resolved.skill))
        : lookupError(resolved);
    },
  };
}

export function createListSkillsTool(
  snapshot: SkillRuntimeSnapshot,
): ToolDefinition<typeof listSkillsParameters> {
  return {
    name: "list_skills",
    description:
      "List available local Skills in deterministic bounded pages. Continue with next-cursor when present.",
    parameters: listSkillsParameters,
    handler: async ({ cursor }) => {
      const result = snapshot.catalog.list(cursor);
      return result.ok
        ? renderSkillListToolResult(result.page)
        : renderSkillToolError("invalid_cursor", "The Skill catalog cursor is invalid or stale.");
    },
  };
}

export function createReadSkillResourceTool(
  snapshot: SkillRuntimeSnapshot,
): ToolDefinition<typeof readSkillResourceParameters> {
  return {
    name: "read_skill_resource",
    description:
      "Read one bounded UTF-8 resource that appears in a loaded Skill's resource inventory.",
    parameters: readSkillResourceParameters,
    handler: async ({ skill, path }) => {
      const resolved = snapshot.catalog.resolve(skill);
      if (!resolved.ok) {
        return lookupError(resolved);
      }
      const read = await snapshot.resources.readText(resolved.skill, path);
      return read.ok
        ? renderSkillResourceToolResult(resolved.skill, read.resource, read.content)
        : renderSkillToolError(RESOURCE_ERROR_CODES[read.reason], read.message);
    },
  };
}

export interface SkillTools {
  readonly readSkill: ReturnType<typeof createReadSkillTool>;
  readonly listSkills: ReturnType<typeof createListSkillsTool>;
  readonly readSkillResource: ReturnType<typeof createReadSkillResourceTool>;
}

/** Create the three Skill tools over a borrowed, process-lifetime snapshot. */
export function createSkillTools(snapshot: SkillRuntimeSnapshot): SkillTools {
  return Object.freeze({
    readSkill: createReadSkillTool(snapshot),
    listSkills: createListSkillsTool(snapshot),
    readSkillResource: createReadSkillResourceTool(snapshot),
  });
}
