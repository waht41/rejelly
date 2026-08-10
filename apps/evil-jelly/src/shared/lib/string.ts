export function escapeRegexLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Normalize CRLF / lone CR to LF for stable text processing. */
export function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Deterministic UTF-16 code-unit ordering without locale-dependent collation. */
export function compareStringsByCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
