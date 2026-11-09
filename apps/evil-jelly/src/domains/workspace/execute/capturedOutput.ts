import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";

export const MAX_COMMAND_CAPTURE_BYTES = 8 * 1024 * 1024;

export interface CommandCaptureStats {
  /** UTF-8 bytes after incremental shell decoding, before removing terminal controls. */
  totalBytes: number;
  retainedBytes: number;
  omittedBytes: number;
}

/** Shared stdout/stderr budget: a fixed prefix and a rolling suffix, never all raw chunks. */
export class BoundedCommandOutput {
  private storage: Buffer | undefined;
  private headLength = 0;
  private tailLength = 0;
  private tailEnd = 0;
  private readonly headCapacity: number;
  private readonly tailCapacity: number;
  totalBytes = 0;

  constructor(private readonly maxBytes = MAX_COMMAND_CAPTURE_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 2) {
      throw new Error("Command capture budget must be an integer of at least 2 bytes.");
    }
    this.headCapacity = Math.floor(maxBytes / 2);
    this.tailCapacity = maxBytes - this.headCapacity;
  }

  append(text: string): void {
    if (!text) return;
    const bytes = Buffer.from(text, "utf8");
    this.totalBytes += bytes.length;
    this.storage ??= Buffer.allocUnsafe(this.maxBytes);
    const headBytes = Math.min(this.headCapacity - this.headLength, bytes.length);
    bytes.copy(this.storage, this.headLength, 0, headBytes);
    this.headLength += headBytes;
    const remaining = bytes.subarray(headBytes);
    if (remaining.length === 0) return;

    const tail = this.storage.subarray(this.headCapacity);
    if (remaining.length >= this.tailCapacity) {
      remaining.copy(tail, 0, remaining.length - this.tailCapacity);
      this.tailEnd = 0;
      this.tailLength = this.tailCapacity;
      return;
    }
    const firstBytes = Math.min(remaining.length, this.tailCapacity - this.tailEnd);
    remaining.copy(tail, this.tailEnd, 0, firstBytes);
    remaining.copy(tail, 0, firstBytes);
    this.tailEnd = (this.tailEnd + remaining.length) % this.tailCapacity;
    this.tailLength = Math.min(this.tailCapacity, this.tailLength + remaining.length);
  }

  snapshot(): { text: string; stats: CommandCaptureStats } {
    const storage = this.storage ?? Buffer.alloc(0);
    const head = storage.subarray(0, this.headLength);
    const tailStorage = storage.subarray(this.headCapacity);
    let tail =
      this.tailLength < this.tailCapacity
        ? tailStorage.subarray(0, this.tailLength)
        : Buffer.concat([
            tailStorage.subarray(this.tailEnd),
            tailStorage.subarray(0, this.tailEnd),
          ]);
    if (this.totalBytes <= this.maxBytes) {
      return {
        text: stripVTControlCharacters(Buffer.concat([head, tail]).toString("utf8")),
        stats: { totalBytes: this.totalBytes, retainedBytes: this.totalBytes, omittedBytes: 0 },
      };
    }

    // The byte ring may cut a UTF-8 code point at either edge of the omitted middle.
    const headText = new StringDecoder("utf8").write(head);
    let tailStart = 0;
    while (tailStart < tail.length && (tail[tailStart] & 0xc0) === 0x80) tailStart++;
    tail = tail.subarray(tailStart);
    const retainedBytes = Buffer.byteLength(headText, "utf8") + tail.length;
    const omittedBytes = this.totalBytes - retainedBytes;
    return {
      text: `${stripVTControlCharacters(headText)}\n[evil-jelly: ${omittedBytes} UTF-8 bytes omitted by capture limit]\n${stripVTControlCharacters(tail.toString("utf8"))}`,
      stats: { totalBytes: this.totalBytes, retainedBytes, omittedBytes },
    };
  }
}
