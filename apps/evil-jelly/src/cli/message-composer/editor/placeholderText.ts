// Legacy display placeholders share one alternation so caret motion and
// deletion can treat either kind as a single indivisible glyph.
const PLACEHOLDER_SOURCE = String.raw`\[Image #\d+\]|\[Pasted text #\d+ \+\d+ (?:lines|chars)\]`;
const PLACEHOLDER_TOKEN = new RegExp(PLACEHOLDER_SOURCE, "g");

/** Half-open `[start, end)` display offsets of one placeholder token. */
export interface PlaceholderSpan {
  start: number;
  end: number;
}

function* placeholderSpans(text: string): Generator<PlaceholderSpan> {
  for (const match of text.matchAll(PLACEHOLDER_TOKEN)) {
    yield { start: match.index, end: match.index + match[0].length };
  }
}

/** The placeholder strictly containing `position`; token edges are outside. */
export function tokenSpanAt(text: string, position: number): PlaceholderSpan | null {
  for (const span of placeholderSpans(text)) {
    if (span.start >= position) break;
    if (position < span.end) return span;
  }
  return null;
}

/** The placeholder ending at, or defensively containing, a deletion caret. */
export function tokenSpanBefore(text: string, cursor: number): PlaceholderSpan | null {
  for (const span of placeholderSpans(text)) {
    if (span.start >= cursor) break;
    if (cursor <= span.end) return span;
  }
  return null;
}

/** Pull a deletion start back to the boundary of any placeholder it entered. */
export function alignDeletionStart(text: string, start: number): number {
  return tokenSpanAt(text, start)?.start ?? start;
}
