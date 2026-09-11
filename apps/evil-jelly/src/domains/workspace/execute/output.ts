export const TRUNCATED_FOR_AGENT_MARKER = "\n...[TRUNCATED_FOR_AGENT]...\n";
export const MAX_OUTPUT_LINE_BYTES = 16 * 1024;

function utf8Head(buffer: Buffer, maxBytes: number): string {
  if (buffer.length <= maxBytes) return buffer.toString("utf8");
  let end = maxBytes;
  while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

function utf8Tail(buffer: Buffer, maxBytes: number): string {
  if (buffer.length <= maxBytes) return buffer.toString("utf8");
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString("utf8");
}

function truncateLine(line: string, maxBytes: number): string {
  const buffer = Buffer.from(line, "utf8");
  if (buffer.length <= maxBytes) return line;

  const marker = `...[LINE TRUNCATED FOR AGENT: ${buffer.length} bytes]...`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes >= maxBytes) return utf8Head(Buffer.from(marker, "utf8"), maxBytes);

  const contentBytes = maxBytes - markerBytes;
  const headBytes = Math.floor(contentBytes / 2);
  const tailBytes = contentBytes - headBytes;
  return `${utf8Head(buffer, headBytes)}${marker}${utf8Tail(buffer, tailBytes)}`;
}

export function truncateLongLines(text: string, maxLineBytes = MAX_OUTPUT_LINE_BYTES): string {
  return text
    .split("\n")
    .map((line) => {
      const carriageReturn = line.endsWith("\r") ? "\r" : "";
      const content = carriageReturn ? line.slice(0, -1) : line;
      return `${truncateLine(content, maxLineBytes)}${carriageReturn}`;
    })
    .join("\n");
}

export function truncateOutput(
  text: string,
  maxBytes: number,
  maxLineBytes = MAX_OUTPUT_LINE_BYTES,
): string {
  const lineTruncated = truncateLongLines(text, maxLineBytes);
  const buf = Buffer.from(lineTruncated, "utf8");
  if (buf.length <= maxBytes) {
    return lineTruncated;
  }
  const headBytes = Math.floor(maxBytes / 2);
  const tailBytes = maxBytes - headBytes;
  const head = buf.subarray(0, headBytes).toString("utf8");
  const tail = buf.subarray(buf.length - tailBytes).toString("utf8");
  return `${head}${TRUNCATED_FOR_AGENT_MARKER}${tail}`;
}
