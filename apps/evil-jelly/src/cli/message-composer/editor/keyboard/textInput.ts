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
// raw control bytes and U+FFFD replacement chars from invalid UTF-8.
function isBinaryPasteControlChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 0x00 && code <= 0x08) || (code >= 0x0e && code <= 0x1f);
}

export function looksBinary(text: string): boolean {
  return [...text].some(isBinaryPasteControlChar) || text.includes("�");
}
