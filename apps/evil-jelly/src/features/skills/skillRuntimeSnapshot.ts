import type { SkillLoadDiagnostic, SkillRuntimeSnapshot } from "./contracts";
import { type LoadedSkillSources, loadLooseSkills } from "./loadLooseSkills";
import { createSkillCatalog } from "./skillCatalog";
import type { SkillSource } from "./skillSourceRoots";

export interface SkillRuntimeSnapshotBuildResult {
  readonly snapshot: SkillRuntimeSnapshot;
  readonly diagnostics: readonly SkillLoadDiagnostic[];
}

/** Join path-free catalog state with the separate path-owning resource repository. */
export function createSkillRuntimeSnapshot(loaded: LoadedSkillSources): SkillRuntimeSnapshot {
  return Object.freeze({
    catalog: createSkillCatalog(loaded.records),
    resources: loaded.resources,
  });
}

/** Load fixed loose sources once and freeze the complete process-lifetime Skill snapshot. */
export async function buildSkillRuntimeSnapshot(
  sources: readonly SkillSource[],
): Promise<SkillRuntimeSnapshotBuildResult> {
  const loaded = await loadLooseSkills(sources);
  return Object.freeze({
    snapshot: createSkillRuntimeSnapshot(loaded),
    diagnostics: loaded.diagnostics,
  });
}
