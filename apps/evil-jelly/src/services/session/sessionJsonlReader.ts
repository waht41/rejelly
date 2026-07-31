import type { FileHandle } from "node:fs/promises";
import { open, readFile, stat, truncate } from "node:fs/promises";
import path from "node:path";
import {
  parseSessionEvent,
  parseSessionMetaLine,
  parseSessionStateEvent,
  type SessionEvent,
  type SessionMetaLine,
  type SessionStateEvent,
} from "./sessionEvents";
import { assertSessionId, resolveSessionsRoot, workspaceBucket } from "./sessionPaths";

/**
 * Session V2 has two deliberately different read paths:
 *
 * - `readSessionEvents` performs a strict, whole-file diagnostic replay. It validates every
 *   sequence number and is appropriate for resume, repair, and projection.
 * - the bounded helpers read only metadata, the tail, or one known offset. They keep session
 *   listing and writer startup independent of total transcript size.
 *
 * Do not replace one with the other without considering both corruption coverage and I/O cost.
 */
const DEFAULT_TAIL_BYTES = 64 * 1024;
const INITIAL_LINE_READ_BYTES = 64 * 1024;
export const MAX_META_LINE_BYTES = 64 * 1024;
export const MAX_EVENT_LINE_BYTES = 128 * 1024 * 1024;

export interface SessionStoragePaths {
  sessionsRoot?: string;
}

export interface SessionReadWarning {
  kind: "trailing_partial_line";
  offset: number;
  byteLength: number;
}

export interface ReadSessionEventsResult {
  meta: SessionMetaLine;
  events: SessionEvent[];
  warnings: SessionReadWarning[];
  /** Byte offset immediately after the last valid newline. */
  validBytes: number;
  /** Bytes ignored after validBytes because the final line was incomplete. */
  trailingBytes: number;
}

export interface LocatedSessionEvent<T extends SessionEvent = SessionEvent> {
  event: T;
  offset: number;
  byteLength: number;
}

export interface SessionAppendPosition {
  kind: "append";
  meta: SessionMetaLine;
  validBytes: number;
  trailingBytes: number;
  lastSeq: number;
  lastEvent?: LocatedSessionEvent;
}

export interface SessionNeedsInitialization {
  kind: "initialize";
}

export class SessionCorruptionError extends Error {
  constructor(
    message: string,
    readonly filePath: string,
    readonly line: number,
    readonly offset: number,
    readonly cause?: unknown,
  ) {
    super(`${message} (${filePath}:${line}, byte ${offset})`);
    this.name = "SessionCorruptionError";
  }
}

interface ParsedLine {
  line: number;
  offset: number;
  byteLength: number;
  value: unknown;
}

interface CompleteLineRead {
  bytes: Buffer;
  byteLength: number;
  complete: boolean;
}

export function resolveV2WorkspaceDir(
  workspaceRoot: string,
  paths: SessionStoragePaths = {},
): string {
  return path.join(paths.sessionsRoot ?? resolveSessionsRoot(), workspaceBucket(workspaceRoot));
}

export function resolveV2SessionPath(
  workspaceRoot: string,
  sessionId: string,
  paths: SessionStoragePaths = {},
): string {
  assertSessionId(sessionId);
  return path.join(resolveV2WorkspaceDir(workspaceRoot, paths), `${sessionId}.jsonl`);
}

function parseJsonLine(bytes: Buffer, filePath: string, line: number, offset: number): unknown {
  const normalized =
    bytes.length > 0 && bytes[bytes.length - 1] === 0x0d ? bytes.subarray(0, -1) : bytes;
  try {
    return JSON.parse(normalized.toString("utf8")) as unknown;
  } catch (error) {
    throw new SessionCorruptionError("Invalid JSONL line", filePath, line, offset, error);
  }
}

function completeLines(
  buffer: Buffer,
  filePath: string,
): {
  lines: ParsedLine[];
  validBytes: number;
  trailingBytes: number;
} {
  const lines: ParsedLine[] = [];
  let start = 0;
  let line = 1;
  while (start < buffer.length) {
    const newline = buffer.indexOf(0x0a, start);
    if (newline < 0) {
      break;
    }
    const bytes = buffer.subarray(start, newline);
    if (bytes.length > 0 && !(bytes.length === 1 && bytes[0] === 0x0d)) {
      lines.push({
        line,
        offset: start,
        byteLength: newline + 1 - start,
        value: parseJsonLine(bytes, filePath, line, start),
      });
    }
    start = newline + 1;
    line += 1;
  }
  return {
    lines,
    validBytes: start,
    trailingBytes: buffer.length - start,
  };
}

function parseSessionBuffer(buffer: Buffer, filePath: string): ReadSessionEventsResult {
  const parsed = completeLines(buffer, filePath);
  const first = parsed.lines[0];
  if (!first || first.line !== 1 || first.offset !== 0) {
    throw new SessionCorruptionError(
      "Session V2 file must start with session_meta",
      filePath,
      first?.line ?? 1,
      first?.offset ?? 0,
    );
  }

  let meta: SessionMetaLine;
  try {
    meta = parseSessionMetaLine(first.value);
  } catch (error) {
    throw new SessionCorruptionError("Invalid session_meta", filePath, 1, 0, error);
  }

  const events: SessionEvent[] = [];
  let expectedSeq = 1;
  for (const entry of parsed.lines.slice(1)) {
    let event: SessionEvent;
    try {
      event = parseSessionEvent(entry.value);
    } catch (error) {
      throw new SessionCorruptionError(
        "Invalid Session V2 event",
        filePath,
        entry.line,
        entry.offset,
        error,
      );
    }
    if (event.seq !== expectedSeq) {
      throw new SessionCorruptionError(
        `Non-contiguous event seq: expected ${expectedSeq}, received ${event.seq}`,
        filePath,
        entry.line,
        entry.offset,
      );
    }
    events.push(event);
    expectedSeq += 1;
  }

  return {
    meta,
    events,
    warnings:
      parsed.trailingBytes > 0
        ? [
            {
              kind: "trailing_partial_line",
              offset: parsed.validBytes,
              byteLength: parsed.trailingBytes,
            },
          ]
        : [],
    validBytes: parsed.validBytes,
    trailingBytes: parsed.trailingBytes,
  };
}

function verifyFileIdentity(
  meta: SessionMetaLine,
  workspaceRoot: string,
  sessionId: string,
  filePath: string,
): void {
  if (meta.sessionId !== sessionId) {
    throw new SessionCorruptionError(
      `Session id mismatch: expected ${sessionId}, received ${meta.sessionId}`,
      filePath,
      1,
      0,
    );
  }
  if (path.resolve(meta.workspaceRoot) !== path.resolve(workspaceRoot)) {
    throw new SessionCorruptionError(
      `Workspace mismatch: expected ${path.resolve(workspaceRoot)}, received ${meta.workspaceRoot}`,
      filePath,
      1,
      0,
    );
  }
}

async function readLineAt(
  handle: FileHandle,
  filePath: string,
  offset: number,
  maxBytes: number,
): Promise<CompleteLineRead> {
  const chunks: Buffer[] = [];
  let total = 0;
  let chunkSize = Math.min(INITIAL_LINE_READ_BYTES, maxBytes);
  while (total < maxBytes) {
    const requested = Math.min(chunkSize, maxBytes - total);
    const chunk = Buffer.allocUnsafe(requested);
    const { bytesRead } = await handle.read(chunk, 0, requested, offset + total);
    if (bytesRead === 0) {
      return { bytes: Buffer.concat(chunks, total), byteLength: total, complete: false };
    }
    const view = chunk.subarray(0, bytesRead);
    const newline = view.indexOf(0x0a);
    if (newline >= 0) {
      chunks.push(view.subarray(0, newline));
      return {
        bytes: Buffer.concat(chunks, total + newline),
        byteLength: total + newline + 1,
        complete: true,
      };
    }
    chunks.push(view);
    total += bytesRead;
    if (bytesRead < requested) {
      return { bytes: Buffer.concat(chunks, total), byteLength: total, complete: false };
    }
    chunkSize = Math.min(chunkSize * 2, maxBytes - total);
  }
  throw new SessionCorruptionError(`JSONL line exceeds ${maxBytes} bytes`, filePath, 0, offset);
}

/** Find the last newline strictly before beforeOffset using bounded-memory reverse reads. */
async function findPreviousNewline(handle: FileHandle, beforeOffset: number): Promise<number> {
  let end = beforeOffset;
  while (end > 0) {
    const start = Math.max(0, end - INITIAL_LINE_READ_BYTES);
    const chunk = Buffer.allocUnsafe(end - start);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, start);
    if (bytesRead <= 0) {
      return -1;
    }
    const index = chunk.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (index >= 0) {
      return start + index;
    }
    end = start;
  }
  return -1;
}

export async function readSessionEvents(
  workspaceRoot: string,
  sessionId: string,
  paths: SessionStoragePaths = {},
): Promise<ReadSessionEventsResult> {
  // Intentionally O(file size): this is the authoritative validation/replay path, not a session
  // picker or writer-open fast path. In particular, it detects corruption in the middle of a log.
  const filePath = resolveV2SessionPath(workspaceRoot, sessionId, paths);
  const result = parseSessionBuffer(await readFile(filePath), filePath);
  verifyFileIdentity(result.meta, workspaceRoot, sessionId, filePath);
  return result;
}

export async function readSessionMetaLine(
  workspaceRoot: string,
  sessionId: string,
  paths: SessionStoragePaths = {},
): Promise<SessionMetaLine> {
  const filePath = resolveV2SessionPath(workspaceRoot, sessionId, paths);
  const handle = await open(filePath, "r");
  try {
    const line = await readLineAt(handle, filePath, 0, MAX_META_LINE_BYTES);
    if (!line.complete) {
      throw new SessionCorruptionError(
        `session_meta exceeds ${MAX_META_LINE_BYTES} bytes or is incomplete`,
        filePath,
        1,
        0,
      );
    }
    let meta: SessionMetaLine;
    try {
      meta = parseSessionMetaLine(parseJsonLine(line.bytes, filePath, 1, 0));
    } catch (error) {
      if (error instanceof SessionCorruptionError) {
        throw error;
      }
      throw new SessionCorruptionError("Invalid session_meta", filePath, 1, 0, error);
    }
    verifyFileIdentity(meta, workspaceRoot, sessionId, filePath);
    return meta;
  } finally {
    await handle.close();
  }
}

export async function findLastEvent(
  workspaceRoot: string,
  sessionId: string,
  paths: SessionStoragePaths = {},
): Promise<SessionEvent | undefined> {
  const meta = await readSessionMetaLine(workspaceRoot, sessionId, paths);
  const filePath = resolveV2SessionPath(workspaceRoot, sessionId, paths);
  const handle = await open(filePath, "r");
  try {
    const inspected = await inspectSessionForAppend(handle, filePath, meta);
    return inspected.kind === "append" ? inspected.lastEvent?.event : undefined;
  } finally {
    await handle.close();
  }
}

/**
 * Locate the durable append boundary without replaying the historical prefix.
 *
 * This validates the immutable meta line and final complete event, but deliberately does not
 * validate every event in between. Full replay remains responsible for detecting middle-of-file
 * corruption. Before the first newline there is no valid durable session fact, so a zero-byte or
 * incomplete first line is creation residue that the writer may safely replace while holding the
 * exclusive writer claim.
 */
export async function inspectSessionForAppend(
  handle: FileHandle,
  filePath: string,
  expectedMeta: SessionMetaLine,
): Promise<SessionAppendPosition | SessionNeedsInitialization> {
  const fileStat = await handle.stat();
  if (fileStat.size === 0) {
    return { kind: "initialize" };
  }

  const first = await readLineAt(handle, filePath, 0, MAX_META_LINE_BYTES);
  if (!first.complete) {
    return { kind: "initialize" };
  }

  let meta: SessionMetaLine;
  try {
    meta = parseSessionMetaLine(parseJsonLine(first.bytes, filePath, 1, 0));
  } catch (error) {
    if (error instanceof SessionCorruptionError) {
      throw error;
    }
    throw new SessionCorruptionError("Invalid session_meta", filePath, 1, 0, error);
  }
  verifyFileIdentity(meta, expectedMeta.workspaceRoot, expectedMeta.sessionId, filePath);

  const lastNewline = await findPreviousNewline(handle, fileStat.size);
  if (lastNewline < 0) {
    throw new SessionCorruptionError(
      "Session V2 file has no complete metadata line",
      filePath,
      1,
      0,
    );
  }
  const validBytes = lastNewline + 1;
  const trailingBytes = fileStat.size - validBytes;

  let lineEnd = lastNewline;
  while (lineEnd > 0) {
    const previousNewline = await findPreviousNewline(handle, lineEnd);
    const lineStart = previousNewline + 1;
    const line = await readLineAt(handle, filePath, lineStart, MAX_EVENT_LINE_BYTES);
    if (!line.complete || lineStart + line.byteLength !== lineEnd + 1) {
      throw new SessionCorruptionError(
        "Final JSONL event is not a complete line",
        filePath,
        0,
        lineStart,
      );
    }
    const normalized =
      line.bytes.length > 0 && line.bytes[line.bytes.length - 1] === 0x0d
        ? line.bytes.subarray(0, -1)
        : line.bytes;
    if (normalized.length === 0) {
      lineEnd = previousNewline;
      continue;
    }
    if (lineStart === 0) {
      return { kind: "append", meta, validBytes, trailingBytes, lastSeq: 0 };
    }
    let event: SessionEvent;
    try {
      event = parseSessionEvent(parseJsonLine(normalized, filePath, 0, lineStart));
    } catch (error) {
      throw new SessionCorruptionError(
        "Invalid final Session V2 event",
        filePath,
        0,
        lineStart,
        error,
      );
    }
    return {
      kind: "append",
      meta,
      validBytes,
      trailingBytes,
      lastSeq: event.seq,
      lastEvent: {
        event,
        offset: lineStart,
        byteLength: line.byteLength,
      },
    };
  }
  return { kind: "append", meta, validBytes, trailingBytes, lastSeq: 0 };
}

export async function readEventAtOffset(
  workspaceRoot: string,
  sessionId: string,
  offset: number,
  paths: SessionStoragePaths = {},
): Promise<LocatedSessionEvent> {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`Invalid event offset: ${offset}`);
  }
  const filePath = resolveV2SessionPath(workspaceRoot, sessionId, paths);
  const handle = await open(filePath, "r");
  try {
    if (offset > 0) {
      const previous = Buffer.allocUnsafe(1);
      const { bytesRead } = await handle.read(previous, 0, 1, offset - 1);
      if (bytesRead !== 1 || previous[0] !== 0x0a) {
        throw new SessionCorruptionError(
          "Event offset is not at a JSONL line boundary",
          filePath,
          0,
          offset,
        );
      }
    }
    const line = await readLineAt(handle, filePath, offset, MAX_EVENT_LINE_BYTES);
    if (!line.complete) {
      throw new SessionCorruptionError(
        "Event offset does not point to a complete line",
        filePath,
        0,
        offset,
      );
    }
    return {
      event: parseSessionEvent(parseJsonLine(line.bytes, filePath, 0, offset)),
      offset,
      byteLength: line.byteLength,
    };
  } finally {
    await handle.close();
  }
}

export async function findLatestSessionStateFromTail(
  workspaceRoot: string,
  sessionId: string,
  options: SessionStoragePaths & { maxBytes?: number } = {},
): Promise<LocatedSessionEvent<SessionStateEvent> | undefined> {
  // This is only a checkpoint fast path. `undefined` can mean no checkpoint, a checkpoint outside
  // the bounded window, or an invalid checkpoint; callers must fall back to authoritative replay.
  const filePath = resolveV2SessionPath(workspaceRoot, sessionId, options);
  const fileStat = await stat(filePath);
  const maxBytes = options.maxBytes ?? DEFAULT_TAIL_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`Invalid tail read size: ${maxBytes}`);
  }
  const start = Math.max(0, fileStat.size - maxBytes);
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(fileStat.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const view = buffer.subarray(0, bytesRead);
    const firstNewline = view.indexOf(0x0a);
    if (start > 0 && firstNewline < 0) {
      return undefined;
    }
    const firstCompleteStart = start === 0 ? 0 : firstNewline + 1;
    const lastNewline = view.lastIndexOf(0x0a);
    if (lastNewline < firstCompleteStart) {
      return undefined;
    }
    let cursor = lastNewline + 1;
    while (cursor > firstCompleteStart) {
      const lineEnd = cursor;
      const previousNewline = cursor >= 2 ? view.lastIndexOf(0x0a, cursor - 2) : -1;
      const lineStart = Math.max(firstCompleteStart, previousNewline + 1);
      if (lineStart >= lineEnd) {
        break;
      }
      cursor = lineStart;
      let line = view.subarray(lineStart, lineEnd);
      if (line.length > 0 && line[line.length - 1] === 0x0a) {
        line = line.subarray(0, -1);
      }
      if (line.length > 0 && line[line.length - 1] === 0x0d) {
        line = line.subarray(0, -1);
      }
      if (line.length === 0) {
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(line.toString("utf8")) as unknown;
      } catch {
        continue;
      }
      if (
        typeof value !== "object" ||
        value === null ||
        !("type" in value) ||
        value.type !== "session_state"
      ) {
        continue;
      }
      let event: SessionStateEvent;
      try {
        event = parseSessionStateEvent(value);
      } catch {
        continue;
      }
      if (
        event.coveredThroughSeq !== event.seq - 1 ||
        (event.lastCompactSeq === undefined) !== (event.lastCompactOffset === undefined)
      ) {
        continue;
      }
      if (event.lastCompactSeq !== undefined && event.lastCompactOffset !== undefined) {
        try {
          const compact = await readEventAtOffset(
            workspaceRoot,
            sessionId,
            event.lastCompactOffset,
            options,
          );
          if (
            compact.event.type !== "context_compacted" ||
            compact.event.seq !== event.lastCompactSeq
          ) {
            continue;
          }
        } catch {
          continue;
        }
      }
      return {
        event,
        offset: start + lineStart,
        byteLength: lineEnd - lineStart,
      };
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

/** Test/repair helper. Normal writer recovery performs this automatically while holding the lock. */
export async function truncateSessionToValidTail(
  filePath: string,
  validBytes: number,
): Promise<void> {
  await truncate(filePath, validBytes);
}
