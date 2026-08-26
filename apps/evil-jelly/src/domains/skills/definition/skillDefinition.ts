import { SKILL_DEFINITION_LIMITS } from "./limits";

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
  if (value.length > SKILL_DEFINITION_LIMITS.skillNameChars) {
    return {
      ok: false,
      value,
      reason: `Skill name must be at most ${SKILL_DEFINITION_LIMITS.skillNameChars} characters.`,
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

/** Immutable model-facing Skill definition with no host filesystem location. */
export interface SkillRecord {
  readonly name: string;
  readonly description: string;
  readonly shortDescription?: string;
  readonly origin: SkillOrigin;
  readonly instruction: string;
  readonly resources: readonly SkillResourceEntry[];
}

export type SkillPathConvention = "posix" | "windows";

/** Model-facing access locator revealed only after a local Skill is activated. */
export interface HostSkillFilesystemAccess {
  readonly kind: "host-filesystem";
  readonly rootPath: string;
  readonly mainResource: "SKILL.md";
  readonly pathConvention: SkillPathConvention;
}

export type SkillAccess = HostSkillFilesystemAccess;

export function qualifiedSkillName(skill: Pick<SkillRecord, "name" | "origin">): string {
  return `${skill.origin.scope}:${skill.name}`;
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

/** Path-free resource access port implemented by the host-backed loader. */
export interface SkillResourceRepository {
  readText(skill: SkillRecord, resourcePath: string): Promise<SkillResourceReadResult>;
}

/** Host-owned access lookup kept separate from the path-free Skill catalog. */
export interface SkillAccessRepository {
  get(skill: SkillRecord): SkillAccess;
}
