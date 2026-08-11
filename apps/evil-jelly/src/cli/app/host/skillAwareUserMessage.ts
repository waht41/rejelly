import type { Message } from "@rejelly/core";
import { SKILL_AGENT_LIMITS } from "../../../domains/skills/agent/limits";
import type { SkillRuntimeSnapshot } from "../../../domains/skills/agent/skillRuntime";
import { renderSkillToolResult } from "../../../domains/skills/agent/skillToolOutput";
import type { SkillRecord } from "../../../domains/skills/definition/skillDefinition";
import { qualifiedSkillName } from "../../../domains/skills/definition/skillDefinition";
import type { LineInputValue, UserSkillReference } from "../../../shared/AgentShared";
import { buildUserMessage } from "../../../shared/attachments/messageContent";
import { appendMessageContentSuffix } from "../../../shared/lib/message";
import { renderPseudoXmlElement } from "../../../shared/lib/pseudoXml";

/** Resolve only structured, qualified picker selections against the enabled process snapshot. */
export function resolveExplicitSkills(
  snapshot: SkillRuntimeSnapshot | undefined,
  references: readonly UserSkillReference[] = [],
): readonly SkillRecord[] {
  if (!snapshot || references.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const resolved: SkillRecord[] = [];
  for (const reference of references.slice(0, SKILL_AGENT_LIMITS.explicitSkillsPerTurn)) {
    const qualifiedName = reference.qualifiedName.trim();
    if (!qualifiedName.includes(":") || seen.has(qualifiedName)) {
      continue;
    }
    const result = snapshot.catalog.resolve(qualifiedName);
    if (!result.ok || qualifiedSkillName(result.skill) !== qualifiedName) {
      continue;
    }
    seen.add(qualifiedName);
    resolved.push(result.skill);
  }
  return resolved;
}

/** Render the Skills that the user explicitly selected for this turn. */
export function renderExplicitSkillContext(skills: readonly SkillRecord[]): string {
  if (skills.length === 0) {
    return "";
  }
  return renderPseudoXmlElement("explicit_skills", skills.map(renderSkillToolResult).join("\n"), {
    count: String(skills.length),
  });
}

/** Build a durable user message whose display stays clean while model context contains the Skills. */
export async function buildSkillAwareUserMessage(
  input: Pick<LineInputValue, "text" | "attachments" | "skills">,
  snapshot: SkillRuntimeSnapshot | undefined,
): Promise<Message> {
  const skills = resolveExplicitSkills(snapshot, input.skills);
  const message = await buildUserMessage({
    userInput: input.text,
    attachments: input.attachments,
  });
  const context = renderExplicitSkillContext(skills);
  return context
    ? { ...message, content: appendMessageContentSuffix(message.content, context) }
    : message;
}
