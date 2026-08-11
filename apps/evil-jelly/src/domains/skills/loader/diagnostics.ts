import type { SkillOrigin } from "../definition/skillDefinition";

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

export function skillDiagnostic(
  code: SkillLoadDiagnostic["code"],
  message: string,
  source?: string,
  origin?: SkillOrigin,
): SkillLoadDiagnostic {
  return {
    severity: "warning",
    code,
    message,
    ...(source ? { source } : {}),
    ...(origin ? { origin } : {}),
  };
}
