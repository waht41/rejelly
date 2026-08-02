import {
  type ContributionProvenance,
  qualifiedContributionName,
} from "../../services/plugin/contracts";
import { SKILL_LIMITS } from "./skillLimits";

export type IdentifierValidationResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly value: string; readonly reason: string };

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const PLUGIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/** Trim and validate a model-facing, contribution-local skill name without rewriting its case. */
export function validateSkillName(input: string): IdentifierValidationResult {
  const value = input.trim();
  if (value.length === 0) {
    return { ok: false, value, reason: "Skill name must not be empty." };
  }
  if (value.length > SKILL_LIMITS.skillNameChars) {
    return {
      ok: false,
      value,
      reason: `Skill name must be at most ${SKILL_LIMITS.skillNameChars} characters.`,
    };
  }
  if (!SKILL_NAME_PATTERN.test(value)) {
    return {
      ok: false,
      value,
      reason:
        "Skill name must start with a lowercase ASCII letter or digit and contain only a-z, 0-9, dot, underscore, or hyphen.",
    };
  }
  return { ok: true, value };
}

/** Trim and validate a stable, dot-segmented formal plugin id. */
export function validatePluginId(input: string): IdentifierValidationResult {
  const value = input.trim();
  if (value.length === 0) {
    return { ok: false, value, reason: "Plugin id must not be empty." };
  }
  if (value.length > SKILL_LIMITS.pluginIdChars) {
    return {
      ok: false,
      value,
      reason: `Plugin id must be at most ${SKILL_LIMITS.pluginIdChars} characters.`,
    };
  }
  if (!PLUGIN_ID_PATTERN.test(value)) {
    return {
      ok: false,
      value,
      reason:
        "Plugin id must contain lowercase ASCII dot-separated segments; each segment may contain internal hyphens.",
    };
  }
  return { ok: true, value };
}

export type SkillResourceKind = "reference" | "asset";

/** Model-safe resource metadata. Paths are skill-relative POSIX paths, never absolute paths. */
export interface SkillResourceEntry {
  readonly path: string;
  readonly kind: SkillResourceKind;
  readonly sizeBytes: number;
}

/**
 * Immutable model-facing skill data.
 *
 * qualifiedName is derived from provenance and name. Filesystem locations belong to the resource
 * repository, not this record.
 */
export interface SkillRecord {
  readonly name: string;
  readonly description: string;
  readonly shortDescription?: string;
  readonly provenance: ContributionProvenance;
  readonly instruction: string;
  readonly resources: readonly SkillResourceEntry[];
}

export function qualifiedSkillName(skill: Pick<SkillRecord, "name" | "provenance">): string {
  // Loading enforces provenance.contributionId === skill.name. Keeping name explicit makes the
  // frontmatter-derived local identity visible while one canonical helper owns qualification.
  return qualifiedContributionName({
    ...skill.provenance,
    contributionId: skill.name,
  });
}

export type SkillResolveResult =
  | { readonly ok: true; readonly skill: SkillRecord }
  | {
      readonly ok: false;
      readonly reason: "not-found" | "ambiguous";
      readonly candidates: readonly string[];
    };

export interface SkillListItem {
  readonly name: string;
  readonly qualifiedName: string;
  readonly description: string;
  readonly shortDescription?: string;
  readonly provenance: ContributionProvenance;
}

export interface SkillListPage {
  readonly items: readonly SkillListItem[];
  readonly nextCursor?: string;
  readonly returned: number;
  readonly total: number;
}

/** Immutable query surface built once at the composition root. */
export interface SkillCatalogSnapshot {
  readonly size: number;
  readonly entries: readonly SkillRecord[];
  resolve(name: string): SkillResolveResult;
  list(cursor?: string): SkillListPage;
}

export type SkillResourceReadResult =
  | { readonly ok: true; readonly content: string }
  | {
      readonly ok: false;
      readonly reason:
        | "resource-not-listed"
        | "resource-escape"
        | "resource-missing"
        | "resource-too-large"
        | "unsupported-binary-resource";
      readonly message: string;
    };

/** Owns internal filesystem locations; the catalog remains path-free and model-safe. */
export interface SkillResourceRepository {
  readText(skill: SkillRecord, resourcePath: string): Promise<SkillResourceReadResult>;
}

/** Borrowed provider injected into an agent run. It owns no lifecycle or teardown behavior. */
export interface SkillRuntimeSnapshot {
  readonly catalog: SkillCatalogSnapshot;
  readonly resources: SkillResourceRepository;
}
