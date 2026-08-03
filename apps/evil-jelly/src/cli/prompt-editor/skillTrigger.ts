import type { UserSkillReference } from "../../shared/AgentShared";
import type { BufferState } from "./textBuffer";

const SKILL_QUERY_PATTERN = /^[a-z0-9._:-]*$/;

/** Return the lowercase Skill query in the active `$token` immediately left of the caret. */
export function extractSkillQuery(text: string, cursor: number): string | null {
  const left = text.slice(0, cursor);
  const dollar = left.lastIndexOf("$");
  if (dollar === -1) {
    return null;
  }
  if (dollar > 0 && left[dollar - 1] !== " " && left[dollar - 1] !== "\n") {
    return null;
  }
  const token = left.slice(dollar + 1);
  if (!SKILL_QUERY_PATTERN.test(token)) {
    return null;
  }
  if (cursor < text.length && !/\s/.test(text[cursor]!)) {
    return null;
  }
  return token;
}

/** Replace only the active `$token`; selected references remain ordinary visible prompt text. */
export function replaceSkillToken(
  state: BufferState,
  qualifiedNames: readonly string[],
): BufferState {
  const { text, cursor } = state;
  const left = text.slice(0, cursor);
  const dollar = left.lastIndexOf("$");
  if (dollar === -1) {
    return state;
  }
  const before = text.slice(0, dollar);
  const after = text.slice(cursor);
  const refs = qualifiedNames.map((name) => `$${name}`).join(" ");
  if (!refs) {
    return { text: before + after, cursor: before.length };
  }
  const insert = after.length === 0 || !/^\s/.test(after) ? `${refs} ` : refs;
  return { text: before + insert + after, cursor: before.length + insert.length };
}

function containsSelectedMarker(text: string, qualifiedName: string): boolean {
  const marker = `$${qualifiedName}`;
  let start = text.indexOf(marker);
  while (start !== -1) {
    const before = start === 0 ? "" : text[start - 1]!;
    const after = text[start + marker.length] ?? "";
    const startsAtBoundary = start === 0 || /\s/.test(before);
    const endsAtBoundary = after === "" || !/[a-z0-9._:-]/.test(after);
    if (startsAtBoundary && endsAtBoundary) {
      return true;
    }
    start = text.indexOf(marker, start + marker.length);
  }
  return false;
}

/** Reconcile only already-selected references; arbitrary `$text` is never interpreted. */
export function skillReferencesPresentInText(
  text: string,
  references: readonly UserSkillReference[],
): UserSkillReference[] {
  return references.filter((reference) => containsSelectedMarker(text, reference.qualifiedName));
}
