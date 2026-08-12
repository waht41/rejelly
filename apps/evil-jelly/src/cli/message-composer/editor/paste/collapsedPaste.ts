const COLLAPSE_PASTE_MIN_LINES = 6;
const COLLAPSE_PASTE_MIN_CHARS = 1200;

// Fragmented paste input arrives much faster than human typing. This window
// keeps typing latency-free while allowing a long burst to become one token.
export const PASTE_COALESCE_MS = 30;
const PASTED_TEXT_TOKEN = /\[Pasted text #(\d+) \+(\d+) (lines|chars)\]/g;

export function pastedLineCount(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

export function shouldCollapsePastedText(text: string): boolean {
  return (
    pastedLineCount(text) >= COLLAPSE_PASTE_MIN_LINES || text.length >= COLLAPSE_PASTE_MIN_CHARS
  );
}

export interface PasteRun {
  text: string;
  at: number;
}

export interface CoalesceResult {
  run: PasteRun;
  collapse: boolean;
}

export function coalescePaste(
  previous: PasteRun | null,
  fragment: string,
  now: number,
  windowMs: number,
): CoalesceResult {
  const contiguous = previous !== null && now - previous.at <= windowMs;
  const text = contiguous ? previous.text + fragment : fragment;
  return { run: { text, at: now }, collapse: shouldCollapsePastedText(text) };
}

export function pastedTextTokenBefore(text: string, cursor: number): string | null {
  return text.slice(0, cursor).match(/\[Pasted text #\d+ \+\d+ (?:lines|chars)\]$/)?.[0] ?? null;
}

export function pastedTextToken(id: number, text: string): string {
  const lines = pastedLineCount(text);
  return lines > 1
    ? `[Pasted text #${id} +${lines} lines]`
    : `[Pasted text #${id} +${text.length} chars]`;
}

export function expandPastedTextTokens(
  text: string,
  pastedTexts: Array<{ id: number; text: string }>,
): string {
  const byId = new Map(pastedTexts.map((paste) => [paste.id, paste.text]));
  return text.replace(
    PASTED_TEXT_TOKEN,
    (token, rawId: string) => byId.get(Number(rawId)) ?? token,
  );
}
