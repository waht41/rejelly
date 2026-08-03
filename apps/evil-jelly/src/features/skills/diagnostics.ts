import type { SkillLoadDiagnostic, SkillOrigin } from "./contracts";

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
