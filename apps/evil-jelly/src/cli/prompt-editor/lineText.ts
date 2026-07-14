/**
 * Pure text helpers shared by the line prompt and its keybinding handler: paste
 * sanitization (control-char stripping, binary-paste detection) and inline
 * attachment/placeholder tokens. No React, no terminal — just string in/out.
 */

const COLLAPSE_PASTE_MIN_LINES = 6;
const COLLAPSE_PASTE_MIN_CHARS = 1200;

// C0 control chars (except tab/newline) and DEL corrupt terminal rendering if
// inserted verbatim — they move the cursor around instead of printing.
function isTerminalControlChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 0x00 && code <= 0x08) || (code >= 0x0b && code <= 0x1f) || code === 0x7f;
}

export function stripControlChars(text: string): string {
  let stripped = "";
  for (const char of text) {
    if (!isTerminalControlChar(char)) {
      stripped += char;
    }
  }
  return stripped;
}

// A binary paste (e.g. pasting an image with Ctrl+V) arrives as garbage bytes:
// raw control bytes and U+FFFD replacement chars from invalid UTF-8. Neither
// appears in legitimate pasted text, so they flag "this is not text to type".
function isBinaryPasteControlChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 0x00 && code <= 0x08) || (code >= 0x0e && code <= 0x1f);
}

export function looksBinary(text: string): boolean {
  return [...text].some(isBinaryPasteControlChar) || text.includes("�");
}

export function pastedLineCount(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return text.split("\n").length;
}

export function shouldCollapsePastedText(text: string): boolean {
  return (
    pastedLineCount(text) >= COLLAPSE_PASTE_MIN_LINES || text.length >= COLLAPSE_PASTE_MIN_CHARS
  );
}

// Attached images live inline as `[Image #N]` tokens (N = the image's 1-based
// position in selectedImages), so they read, move, and delete like normal text.
export const IMAGE_TOKEN = /\[Image #(\d+)\]/g;
export const PASTED_TEXT_TOKEN = /\[Pasted text #(\d+) \+(\d+) (lines|chars)\]/g;

/** The `[Image #N]` token ending exactly at `cursor`, if any (for atomic delete). */
export function imageTokenBefore(text: string, cursor: number): string | null {
  return text.slice(0, cursor).match(/\[Image #\d+\]$/)?.[0] ?? null;
}

/** The `[Pasted text #N +X lines]` token ending exactly at `cursor`, if any. */
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

/** Images still referenced by a `[Image #N]` token in `text`, in first-seen order. */
export function attachedImages(text: string, images: string[]): string[] {
  const nums = [...text.matchAll(IMAGE_TOKEN)].map((m) => Number(m[1]));
  return [...new Set(nums)].map((n) => images[n - 1]).filter((p): p is string => Boolean(p));
}
