import fs from "node:fs/promises";

export type BoundedUtf8FileReadResult =
  | { readonly ok: true; readonly content: string }
  | {
      readonly ok: false;
      readonly reason: "unavailable" | "too-large" | "invalid-utf8";
      readonly message: string;
    };

/** Size-check, read, recheck, and strictly decode one bounded UTF-8 file. */
export async function readBoundedUtf8File(
  filePath: string,
  maxBytes: number,
): Promise<BoundedUtf8FileReadResult> {
  let buffer: Buffer;
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > maxBytes) {
      return { ok: false, reason: "too-large", message: `File exceeds ${maxBytes} bytes.` };
    }
    buffer = await fs.readFile(filePath);
  } catch (error: unknown) {
    return {
      ok: false,
      reason: "unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (buffer.byteLength > maxBytes) {
    return { ok: false, reason: "too-large", message: `File exceeds ${maxBytes} bytes.` };
  }

  try {
    return {
      ok: true,
      content: new TextDecoder("utf-8", { fatal: true }).decode(buffer),
    };
  } catch {
    return { ok: false, reason: "invalid-utf8", message: "File is not valid UTF-8." };
  }
}
