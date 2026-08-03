import { SKILL_LIMITS } from "./limits";

/** Versioned runWith provider key for the borrowed process-lifetime Skill snapshot. */
export const SKILL_RUNTIME_PROVIDER_KEY = "evil-jelly:skill-runtime:v1";

export type SkillScope = "user" | "project";

/** Model-safe identity of the fixed loose source that supplied a Skill. */
export interface SkillOrigin {
  readonly scope: SkillScope;
}

const SKILL_ORIGINS: Readonly<Record<SkillScope, SkillOrigin>> = Object.freeze({
  user: Object.freeze({ scope: "user" }),
  project: Object.freeze({ scope: "project" }),
});

export function skillOrigin(scope: SkillScope): SkillOrigin {
  return SKILL_ORIGINS[scope];
}

export type SkillLoadDiagnosticCode =
  | "skill.source.invalid"
  | "skill.source.duplicate"
  | "skill.source.limit-exceeded"
  | "skill.directory.invalid"
  | "skill.file.invalid"
  | "skill.file.too-large"
  | "skill.frontmatter.invalid"
  | "skill.name.duplicate"
  | "skill.load.failed"
  | "skill.resource.escape"
  | "skill.resource.invalid"
  | "skill.resource.limit-exceeded";

/** Host-facing, non-fatal loading problem. `source` may contain a local path. */
export interface SkillLoadDiagnostic {
  readonly severity: "warning";
  readonly code: SkillLoadDiagnosticCode;
  readonly message: string;
  readonly source?: string;
  readonly origin?: SkillOrigin;
}

export type IdentifierValidationResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly value: string; readonly reason: string };

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** Trim and validate a model-facing Skill name without rewriting its case. */
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
 * qualifiedName is derived from origin and name. Filesystem locations belong to the resource
 * repository, not this record.
 */
export interface SkillRecord {
  readonly name: string;
  readonly description: string;
  readonly shortDescription?: string;
  readonly origin: SkillOrigin;
  readonly instruction: string;
  readonly resources: readonly SkillResourceEntry[];
}

export function qualifiedSkillName(skill: Pick<SkillRecord, "name" | "origin">): string {
  return `${skill.origin.scope}:${skill.name}`;
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
  readonly origin: SkillOrigin;
}

export interface SkillListPage {
  readonly items: readonly SkillListItem[];
  readonly nextCursor?: string;
  readonly returned: number;
  readonly total: number;
}

export type SkillListResult =
  | { readonly ok: true; readonly page: SkillListPage }
  | { readonly ok: false; readonly reason: "invalid-cursor" };

/** Immutable query surface built once at the composition root. */
export interface SkillCatalogSnapshot {
  readonly size: number;
  readonly fingerprint: string;
  readonly entries: readonly SkillRecord[];
  resolve(name: string): SkillResolveResult;
  list(cursor?: string): SkillListResult;
}

export interface RenderedSkillCatalog {
  readonly text: string;
  readonly mode: "full" | "truncated-description" | "names-only" | "partial";
  readonly estimatedTokens: number;
  readonly omittedCount: number;
}

export type SkillResourceReadResult =
  | {
      readonly ok: true;
      readonly content: string;
      readonly resource: SkillResourceEntry;
    }
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
