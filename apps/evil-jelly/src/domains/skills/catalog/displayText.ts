/** Collapse author-controlled metadata to one stable model-facing line. */
export function normalizeSkillDisplayText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/** Truncate by Unicode code points without splitting a surrogate pair. */
export function truncateSkillDisplayText(value: string, maxChars: number): string {
  const normalized = normalizeSkillDisplayText(value);
  const chars = [...normalized];
  if (chars.length <= maxChars) {
    return normalized;
  }
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}
