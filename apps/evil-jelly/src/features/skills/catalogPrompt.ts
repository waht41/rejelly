import { renderPseudoXmlElement } from "../../shared/lib/pseudoXml";
import { estimateTokens } from "../../shared/lib/tokens";
import type { RenderedSkillCatalog, SkillCatalogSnapshot, SkillRecord } from "./contracts";
import { qualifiedSkillName } from "./contracts";
import { normalizeSkillDisplayText, truncateSkillDisplayText } from "./displayText";
import { SKILL_LIMITS } from "./limits";

const CATALOG_BUDGET_RATIO = 0.02;
const HEADER = "## Skills\n\nAvailable local Skills:";
const FOOTER = "Use the `read_skill` tool to load a Skill when it applies.";

type CatalogMode = RenderedSkillCatalog["mode"];

function renderEntries(
  entries: readonly SkillRecord[],
  descriptionMode: "full" | "truncated" | "none",
  omittedCount: number,
): string {
  const lines = [HEADER];
  for (const skill of entries) {
    const name = qualifiedSkillName(skill);
    if (descriptionMode === "none") {
      lines.push(`- ${name}`);
      continue;
    }
    const description =
      descriptionMode === "full"
        ? normalizeSkillDisplayText(skill.description)
        : truncateSkillDisplayText(skill.description, SKILL_LIMITS.listingDescriptionChars);
    lines.push(`- ${name}: ${description}`);
  }
  if (omittedCount > 0) {
    lines.push(`- … ${omittedCount} more Skills omitted; use \`list_skills\` to continue.`);
  }
  lines.push("", FOOTER);
  return renderPseudoXmlElement("available_skills", lines.join("\n"));
}

function rendered(text: string, mode: CatalogMode, omittedCount: number): RenderedSkillCatalog {
  return Object.freeze({ text, mode, estimatedTokens: estimateTokens(text), omittedCount });
}

function fits(text: string, budgetTokens: number): boolean {
  return estimateTokens(text) <= budgetTokens;
}

/** Render one deterministic catalog instruction within 2% of the supplied model context window. */
export function renderSkillCatalog(
  catalog: SkillCatalogSnapshot,
  contextWindowTokens: number,
): RenderedSkillCatalog {
  if (catalog.size === 0) {
    return rendered("", "full", 0);
  }
  const budgetTokens = Number.isFinite(contextWindowTokens)
    ? Math.max(0, Math.floor(contextWindowTokens * CATALOG_BUDGET_RATIO))
    : 0;

  const full = renderEntries(catalog.entries, "full", 0);
  if (fits(full, budgetTokens)) {
    return rendered(full, "full", 0);
  }

  const truncated = renderEntries(catalog.entries, "truncated", 0);
  if (fits(truncated, budgetTokens)) {
    return rendered(truncated, "truncated-description", 0);
  }

  const namesOnly = renderEntries(catalog.entries, "none", 0);
  if (fits(namesOnly, budgetTokens)) {
    return rendered(namesOnly, "names-only", 0);
  }

  for (let count = catalog.entries.length - 1; count >= 0; count -= 1) {
    const omittedCount = catalog.entries.length - count;
    const partial = renderEntries(catalog.entries.slice(0, count), "none", omittedCount);
    if (fits(partial, budgetTokens)) {
      return rendered(partial, "partial", omittedCount);
    }
  }

  // An unrealistically tiny supplied window may not fit even the header and omitted marker.
  return rendered("", "partial", catalog.entries.length);
}
