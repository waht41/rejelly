import type { SkillCatalogSnapshot } from "../catalog/skillCatalog";
import type { SkillAccessRepository, SkillResourceRepository } from "../definition/skillDefinition";

/** Versioned runWith provider key for the borrowed process-lifetime Skill snapshot. */
export const SKILL_RUNTIME_PROVIDER_KEY = "evil-jelly:skill-runtime:v1";

/** Borrowed provider injected into an agent run. It owns no lifecycle or teardown behavior. */
export interface SkillRuntimeSnapshot {
  readonly catalog: SkillCatalogSnapshot;
  readonly access: SkillAccessRepository;
  readonly resources: SkillResourceRepository;
}
