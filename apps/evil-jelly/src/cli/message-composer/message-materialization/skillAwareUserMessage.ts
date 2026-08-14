import { SKILL_AGENT_LIMITS } from "../../../domains/skills/agent/limits";
import type { SkillRuntimeSnapshot } from "../../../domains/skills/agent/skillRuntime";
import { renderSkillToolResult } from "../../../domains/skills/agent/skillToolOutput";
import type { SkillRecord } from "../../../domains/skills/definition/skillDefinition";
import { qualifiedSkillName } from "../../../domains/skills/definition/skillDefinition";
import { promptTokens } from "../../../shared/model/prompt/promptDocument";
import type { PromptInput } from "../../../shared/model/prompt/promptInput";
import { renderPseudoXmlElement } from "../../../shared/model/prompt/pseudoXml";
import type { UserInputMaterializationV1 } from "../../../shared/model/prompt/userInputMaterialization";
import { materializeUserInput } from "./userMessage";

/** Resolve semantic Skill tokens against the enabled process snapshot. */
export function resolveExplicitSkills(
  snapshot: SkillRuntimeSnapshot | undefined,
  qualifiedNames: readonly string[] = [],
): readonly SkillRecord[] {
  if (!snapshot || qualifiedNames.length === 0) return [];
  const seen = new Set<string>();
  const resolved: SkillRecord[] = [];
  for (const rawQualifiedName of qualifiedNames.slice(
    0,
    SKILL_AGENT_LIMITS.explicitSkillsPerTurn,
  )) {
    const qualifiedName = rawQualifiedName.trim();
    if (!qualifiedName.includes(":") || seen.has(qualifiedName)) continue;
    const result = snapshot.catalog.resolve(qualifiedName);
    if (!result.ok || qualifiedSkillName(result.skill) !== qualifiedName) continue;
    seen.add(qualifiedName);
    resolved.push(result.skill);
  }
  return resolved;
}

/** Render the Skills that the user explicitly selected for this turn. */
export function renderExplicitSkillContext(skills: readonly SkillRecord[]): string {
  if (skills.length === 0) return "";
  return renderPseudoXmlElement("explicit_skills", skills.map(renderSkillToolResult).join("\n"), {
    count: String(skills.length),
  });
}

/** Resolve Skill tokens, preserve their markers in place, then append one instruction block. */
export async function materializeSkillAwareUserInput(
  input: PromptInput,
  snapshot: SkillRuntimeSnapshot | undefined,
): Promise<UserInputMaterializationV1> {
  const skills = resolveExplicitSkills(
    snapshot,
    promptTokens(input.document, "skill").map((token) => token.qualifiedName),
  );
  const skillByName = new Map(
    skills.map((skill) => [
      qualifiedSkillName(skill),
      { status: "resolved" as const, context: renderSkillToolResult(skill) },
    ]),
  );
  return materializeUserInput(input, {
    skillContext: renderExplicitSkillContext(skills),
    skillResolution: (qualifiedName) => {
      return skillByName.get(qualifiedName) ?? { status: "unavailable" };
    },
  });
}
