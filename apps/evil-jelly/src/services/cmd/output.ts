export const TRUNCATED_FOR_AGENT_MARKER = "\n...[TRUNCATED_FOR_AGENT]...\n";

export function truncateOutput(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) {
    return text;
  }
  const headBytes = Math.floor(maxBytes / 2);
  const tailBytes = maxBytes - headBytes;
  const head = buf.subarray(0, headBytes).toString("utf8");
  const tail = buf.subarray(buf.length - tailBytes).toString("utf8");
  return `${head}${TRUNCATED_FOR_AGENT_MARKER}${tail}`;
}
