import { renderPseudoXmlElement, renderPseudoXmlEmptyElement } from "../../../shared/lib/pseudoXml";
import { truncateSkillDisplayText } from "../catalog/displayText";
import type { SkillListPage } from "../catalog/skillCatalog";
import type { SkillRecord, SkillResourceEntry } from "../definition/skillDefinition";
import { qualifiedSkillName } from "../definition/skillDefinition";
import { SKILL_AGENT_LIMITS } from "./limits";

export type SkillToolErrorCode =
  | "skill_not_found"
  | "skill_ambiguous"
  | "invalid_cursor"
  | "resource_not_listed"
  | "resource_escape"
  | "resource_missing"
  | "resource_too_large"
  | "unsupported_binary_resource";

function renderResourceInventory(
  resources: readonly SkillResourceEntry[],
  returned: number,
): string {
  const attributes = {
    count: String(resources.length),
    returned: String(returned),
    omitted: String(resources.length - returned),
  };
  if (returned === 0) {
    return renderPseudoXmlEmptyElement("skill_resources", attributes);
  }
  return renderPseudoXmlElement(
    "skill_resources",
    resources
      .slice(0, returned)
      .map((resource) =>
        renderPseudoXmlEmptyElement("skill_resource", {
          path: resource.path,
          kind: resource.kind,
          "size-bytes": String(resource.sizeBytes),
        }),
      )
      .join("\n"),
    attributes,
  );
}

function renderSkillWithResources(skill: SkillRecord, returnedResources: number): string {
  const instruction = renderPseudoXmlElement("skill_instructions", skill.instruction);
  const resources = renderResourceInventory(skill.resources, returnedResources);
  return renderPseudoXmlElement("skill", `${instruction}\n${resources}`, {
    name: skill.name,
    "qualified-name": qualifiedSkillName(skill),
    scope: skill.origin.scope,
  });
}

/** Render the complete snapshot instruction plus the largest bounded resource inventory prefix. */
export function renderSkillToolResult(skill: SkillRecord): string {
  let output = renderSkillWithResources(skill, 0);
  if (output.length > SKILL_AGENT_LIMITS.skillToolOutputChars) {
    throw new Error("Skill instruction exceeded the validated tool output invariant.");
  }
  for (let returned = 1; returned <= skill.resources.length; returned += 1) {
    const candidate = renderSkillWithResources(skill, returned);
    if (candidate.length > SKILL_AGENT_LIMITS.skillToolOutputChars) {
      break;
    }
    output = candidate;
  }
  return output;
}

/** Render one already-bounded catalog page without exposing host filesystem data. */
export function renderSkillListToolResult(page: SkillListPage): string {
  const body = page.items
    .map((item) =>
      renderPseudoXmlElement("skill_listing", item.description, {
        name: item.name,
        "qualified-name": item.qualifiedName,
        scope: item.origin.scope,
      }),
    )
    .join("\n");
  const output = renderPseudoXmlElement("skills", body, {
    returned: String(page.returned),
    total: String(page.total),
    ...(page.nextCursor ? { "next-cursor": page.nextCursor } : {}),
  });
  if (output.length > SKILL_AGENT_LIMITS.listToolOutputChars) {
    throw new Error("Skill list exceeded the validated tool output invariant.");
  }
  return output;
}

/** Render a bounded resource read using only its canonical inventory path. */
export function renderSkillResourceToolResult(
  skill: SkillRecord,
  resource: SkillResourceEntry,
  content: string,
): string {
  const output = renderPseudoXmlElement("skill_resource", content, {
    skill: qualifiedSkillName(skill),
    path: resource.path,
    kind: resource.kind,
    "size-bytes": String(resource.sizeBytes),
  });
  if (output.length > SKILL_AGENT_LIMITS.resourceToolOutputChars) {
    return renderSkillToolError(
      "resource_too_large",
      "The Skill resource and its canonical metadata exceed the tool output limit.",
    );
  }
  return output;
}

/** Render stable model-facing errors; callers supply only bounded host-generated detail. */
export function renderSkillToolError(code: SkillToolErrorCode, message: string): string {
  return renderPseudoXmlElement(
    "skill_error",
    truncateSkillDisplayText(message, SKILL_AGENT_LIMITS.toolErrorMessageChars),
    { code },
  );
}
