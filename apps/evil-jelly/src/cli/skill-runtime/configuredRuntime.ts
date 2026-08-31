import type { SkillRuntimeSnapshot } from "../../domains/skills/agent/skillRuntime";
import { createSkillCatalog } from "../../domains/skills/catalog/skillCatalog";
import {
  qualifiedSkillName,
  type SkillRecord,
} from "../../domains/skills/definition/skillDefinition";
import type { SkillLoadDiagnostic } from "../../domains/skills/loader/diagnostics";
import {
  type LoadedSkillSources,
  loadLooseSkills,
  type SkillRecordPredicate,
} from "../../domains/skills/loader/loadLooseSkills";
import {
  discoverSkillSources,
  resolveSkillRoots,
  type SkillSource,
} from "../../domains/skills/loader/skillSourceRoots";
import { getSettings, type ResolvedSettings } from "../../shared/configuration/settings";
import { getWorkspaceRoot } from "../../shared/fs-policy/workspace-context";
import { resolveGlobalJellyDir } from "../../shared/globalPath";

export interface SkillRuntimeSnapshotBuildResult {
  readonly snapshot: SkillRuntimeSnapshot;
  readonly diagnostics: readonly SkillLoadDiagnostic[];
}

/** Apply the already-resolved master switch and qualified-name override to one loaded Skill. */
export function isSkillEnabled(
  settings: ResolvedSettings["skills"],
  skill: Pick<SkillRecord, "name" | "origin">,
): boolean {
  return settings.enabled && (settings.overrides[qualifiedSkillName(skill)]?.enabled ?? true);
}

/** Join the path-free catalog with separate host-owned access and resource repositories. */
export function createSkillRuntimeSnapshot(loaded: LoadedSkillSources): SkillRuntimeSnapshot {
  return Object.freeze({
    catalog: createSkillCatalog(loaded.records),
    access: loaded.access,
    resources: loaded.resources,
  });
}

/** Load fixed loose sources once and freeze the complete process-lifetime Skill snapshot. */
export async function buildSkillRuntimeSnapshot(
  sources: readonly SkillSource[],
  includeSkill?: SkillRecordPredicate,
): Promise<SkillRuntimeSnapshotBuildResult> {
  const loaded = await loadLooseSkills(sources, includeSkill);
  return Object.freeze({
    snapshot: createSkillRuntimeSnapshot(loaded),
    diagnostics: loaded.diagnostics,
  });
}

/** Discover both configured loose roots and build one process-lifetime runtime snapshot. */
export async function buildConfiguredSkillRuntimeSnapshot(): Promise<SkillRuntimeSnapshotBuildResult> {
  const skillSettings = getSettings().skills;
  if (!skillSettings.enabled) {
    return buildSkillRuntimeSnapshot([]);
  }
  const discovery = await discoverSkillSources(
    resolveSkillRoots(getWorkspaceRoot(), resolveGlobalJellyDir()),
  );
  const built = await buildSkillRuntimeSnapshot(discovery.sources, (skill) =>
    isSkillEnabled(skillSettings, skill),
  );
  return Object.freeze({
    snapshot: built.snapshot,
    diagnostics: Object.freeze([...discovery.diagnostics, ...built.diagnostics]),
  });
}
