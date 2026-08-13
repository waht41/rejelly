import type { SkillRuntimeSnapshotBuildResult } from "./configuredRuntime";

const SKILL_STARTUP_SUMMARY_CHARS = 1_000;

/** Format one bounded, path-free startup line; the normal empty state stays silent. */
export function formatSkillRuntimeStartupSummary(
  result: SkillRuntimeSnapshotBuildResult,
): string | undefined {
  const { size } = result.snapshot.catalog;
  if (size === 0 && result.diagnostics.length === 0) return undefined;

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
