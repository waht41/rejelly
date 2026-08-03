import { getSettings, type ResolvedSettings } from "../../shared/settings";
import {
  qualifiedSkillName,
  type SkillLoadDiagnostic,
  type SkillRecord,
  type SkillRuntimeSnapshot,
} from "./contracts";
import {
  type LoadedSkillSources,
  loadLooseSkills,
  type SkillRecordPredicate,
} from "./loadLooseSkills";
import { createSkillCatalog } from "./skillCatalog";
import {
  discoverSkillSources,
  resolveConfiguredSkillRoots,
  type SkillSource,
} from "./skillSourceRoots";

const SKILL_STARTUP_SUMMARY_CHARS = 1_000;

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
  const discovery = await discoverSkillSources(resolveConfiguredSkillRoots());
  const built = await buildSkillRuntimeSnapshot(discovery.sources, (skill) =>
    isSkillEnabled(skillSettings, skill),
  );
  return Object.freeze({
    snapshot: built.snapshot,
    diagnostics: Object.freeze([...discovery.diagnostics, ...built.diagnostics]),
  });
}

/** Format one bounded, path-free startup line; the normal empty state stays silent. */
export function formatSkillRuntimeStartupSummary(
  result: SkillRuntimeSnapshotBuildResult,
): string | undefined {
  const { size } = result.snapshot.catalog;
  if (size === 0 && result.diagnostics.length === 0) {
    return undefined;
  }
  const counts = new Map<string, number>();
  for (const diagnostic of result.diagnostics) {
    counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
  }
  const warningSummary = [...counts.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([code, count]) => `${code}: ${count}`)
    .join(", ");
  const summary =
    result.diagnostics.length === 0
      ? `Loaded ${size} local Skill${size === 1 ? "" : "s"}.`
      : `Loaded ${size} local Skill${size === 1 ? "" : "s"} with ${result.diagnostics.length} warning${result.diagnostics.length === 1 ? "" : "s"} (${warningSummary}).`;
  return summary.length <= SKILL_STARTUP_SUMMARY_CHARS
    ? summary
    : `${summary.slice(0, SKILL_STARTUP_SUMMARY_CHARS - 1)}…`;
}
