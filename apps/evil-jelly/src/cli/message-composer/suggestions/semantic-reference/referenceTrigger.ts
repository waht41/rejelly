import type { BufferState } from "../../editor/document/textBuffer";

const REFERENCE_QUERY_PATTERN = /^[\p{L}\p{N}._:-]*$/u;

/** Return the lowercase query in the active `$token` immediately left of the caret. */
export function extractReferenceQuery(text: string, cursor: number): string | null {
  const left = text.slice(0, cursor);
  const dollar = left.lastIndexOf("$");
  if (dollar === -1) {
    return null;
  }
  if (dollar > 0 && left[dollar - 1] !== " " && left[dollar - 1] !== "\n") {
    return null;
  }
  const token = left.slice(dollar + 1);
  if (!REFERENCE_QUERY_PATTERN.test(token) || token !== token.toLocaleLowerCase()) {
    return null;
  }
  if (cursor < text.length && !/\s/.test(text[cursor]!)) {
    return null;
  }
  return token;
}

export interface ActiveReferenceTrigger {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

export function activeReferenceTrigger(
  text: string,
  cursor: number,
): ActiveReferenceTrigger | null {
  const query = extractReferenceQuery(text, cursor);
  if (query === null) {
    return null;
  }
  return { start: cursor - query.length - 1, end: cursor, query };
}

/** Remove the unfinished text trigger when the picker is dismissed. */
export function removeActiveReferenceTrigger(state: BufferState): BufferState {
  const { text, cursor } = state;
  const left = text.slice(0, cursor);
  const dollar = left.lastIndexOf("$");
  if (dollar === -1) {
    return state;
  }
  const before = text.slice(0, dollar);
  const after = text.slice(cursor);
  return { text: before + after, cursor: before.length };
}
