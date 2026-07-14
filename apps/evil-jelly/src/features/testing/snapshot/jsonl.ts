/**
 * JSONL layer: UTF-8 file or string → one JSON object per non-empty line (no TraceEvent semantics).
 */

export type JsonlObject = Record<string, unknown>;

/** Split content into lines, parse each non-empty line as a JSON object. */
export function parseJsonlTextToObjects(content: string): JsonlObject[] {
  const lines = content.split(/\r?\n/);
  const rows: JsonlObject[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) {
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Invalid JSON at line ${i + 1}: ${msg}`);
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Expected JSON object at line ${i + 1}`);
    }
    rows.push(raw as JsonlObject);
  }
  return rows;
}
