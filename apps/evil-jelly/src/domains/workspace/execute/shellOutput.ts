import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";

const WINDOWS_ENCODING_SAMPLE_BYTES = 128;

type Utf8Status = "valid" | "invalid" | "incomplete";

/** Incrementally decodes shell output while preserving Windows' GB18030 fallback behavior. */
export class ShellOutputStreamDecoder {
  private readonly utf8Decoder = new StringDecoder("utf8");
  private readonly gb18030Decoder = new TextDecoder("gb18030");
  private mode: "unknown" | "utf8" | "gb18030";
  private pendingChunks: Buffer[] = [];
  private pendingBytes = 0;

  constructor(useWindowsEncodingFallback = process.platform === "win32") {
    this.mode = useWindowsEncodingFallback ? "unknown" : "utf8";
  }

  write(chunk: Buffer): string {
    if (this.mode === "utf8") {
      return this.utf8Decoder.write(chunk);
    }
    if (this.mode === "gb18030") {
      return this.gb18030Decoder.decode(chunk, { stream: true });
    }

    if (this.pendingBytes === 0 && chunk.every((byte) => byte < 0x80)) {
      return chunk.toString("utf8");
    }

    this.pendingChunks.push(chunk);
    this.pendingBytes += chunk.length;
    const pending = Buffer.concat(this.pendingChunks, this.pendingBytes);
    const utf8Status = getUtf8Status(pending);
    if (utf8Status === "invalid") {
      return this.flushPendingWithEncoding("gb18030");
    }
    if (this.pendingBytes < WINDOWS_ENCODING_SAMPLE_BYTES || utf8Status === "incomplete") {
      return "";
    }

    return this.flushPendingWithEncoding("utf8");
  }

  end(): string {
    if (this.mode === "unknown") {
      const pending = Buffer.concat(this.pendingChunks, this.pendingBytes);
      return this.flushPendingWithEncoding(getUtf8Status(pending) === "valid" ? "utf8" : "gb18030");
    }
    if (this.mode === "gb18030") {
      return this.gb18030Decoder.decode();
    }
    return this.utf8Decoder.end();
  }

  private flushPendingWithEncoding(mode: "utf8" | "gb18030"): string {
    const pending = Buffer.concat(this.pendingChunks, this.pendingBytes);
    this.pendingChunks = [];
    this.pendingBytes = 0;
    this.mode = mode;
    if (this.mode === "utf8") {
      return this.utf8Decoder.write(pending);
    }
    return this.gb18030Decoder.decode(pending, { stream: true });
  }
}

function getUtf8Status(chunk: Buffer): Utf8Status {
  let i = 0;
  while (i < chunk.length) {
    const first = chunk[i]!;
    if (first <= 0x7f) {
      i += 1;
      continue;
    }

    let needed: number;
    let codePoint: number;
    let minCodePoint: number;
    if (first >= 0xc2 && first <= 0xdf) {
      needed = 1;
      codePoint = first & 0x1f;
      minCodePoint = 0x80;
    } else if (first >= 0xe0 && first <= 0xef) {
      needed = 2;
      codePoint = first & 0x0f;
      minCodePoint = 0x800;
    } else if (first >= 0xf0 && first <= 0xf4) {
      needed = 3;
      codePoint = first & 0x07;
      minCodePoint = 0x10000;
    } else {
      return "invalid";
    }

    if (i + needed >= chunk.length) {
      return "incomplete";
    }

    for (let j = 1; j <= needed; j += 1) {
      const continuation = chunk[i + j]!;
      if (continuation < 0x80 || continuation > 0xbf) {
        return "invalid";
      }
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }

    if (
      codePoint < minCodePoint ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      codePoint > 0x10ffff
    ) {
      return "invalid";
    }

    i += needed + 1;
  }
  return "valid";
}

function isValidUtf8(chunk: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(chunk);
    return true;
  } catch {
    return false;
  }
}

export function decodeShellOutput(
  buffer: Buffer,
  useWindowsEncodingFallback = process.platform === "win32",
): string {
  if (buffer.length === 0) {
    return "";
  }
  if (!useWindowsEncodingFallback || isValidUtf8(buffer)) {
    return buffer.toString("utf8");
  }
  return new TextDecoder("gb18030").decode(buffer);
}

export function combineCapturedShellOutput(stdout: Buffer, stderr: Buffer): string {
  return stripVTControlCharacters(
    [decodeShellOutput(stdout), decodeShellOutput(stderr)].filter(Boolean).join("\n"),
  );
}
