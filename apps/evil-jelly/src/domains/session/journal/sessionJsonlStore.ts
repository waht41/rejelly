import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import path from "node:path";
import {
  type NewSessionEvent,
  parseNewSessionEvent,
  parseSessionEvent,
  parseSessionMetaLine,
  type SessionMetaLine,
} from "../model/sessionEvents";
import { persistMessageImageBlobs, type SessionBlobStoreOptions } from "./sessionBlobStore";
import {
  inspectSessionForAppend,
  type LocatedSessionEvent,
  MAX_EVENT_LINE_BYTES,
  resolveV2SessionPath,
  type SessionAppendPosition,
  type SessionStoragePaths,
} from "./sessionJsonlReader";
import { assertSessionId } from "./sessionPaths";
import { acquireSessionWriterLock, releaseSessionWriterLock } from "./sessionWriterLock";

/**
 * The writer facade owns the persistence ordering:
 * validate the event, durably externalize large payloads, serialize it, then append it.
 * Read/replay and corruption diagnostics live in `sessionJsonlReader` so opening a writer does not
 * accidentally become an O(total history) operation.
 */
export type {
  LocatedSessionEvent,
  ReadSessionEventsResult,
  SessionReadWarning,
  SessionStoragePaths,
} from "./sessionJsonlReader";
export {
  findLastEvent,
  findLatestSessionStateFromTail,
  readEventAtOffset,
  readSessionEvents,
  readSessionMetaLine,
  resolveV2SessionPath,
  resolveV2WorkspaceDir,
  SessionCorruptionError,
  truncateSessionToValidTail,
} from "./sessionJsonlReader";
export { SessionWriterLockedError } from "./sessionWriterLock";

export function createSessionMetaLine(input: {
  sessionId: string;
  workspaceRoot: string;
  createdAt?: number;
  originator: string;
  appVersion: string;
}): SessionMetaLine {
  assertSessionId(input.sessionId);
  return parseSessionMetaLine({
    type: "session_meta",
    schemaVersion: 2,
    sessionId: input.sessionId,
    workspaceRoot: path.resolve(input.workspaceRoot),
    createdAt: input.createdAt ?? Date.now(),
    originator: input.originator,
    appVersion: input.appVersion,
  });
}

async function writeAll(handle: FileHandle, bytes: Buffer, position: number): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const result = await handle.write(bytes, written, bytes.length - written, position + written);
    if (result.bytesWritten <= 0) {
      throw new Error("Session writer made no progress");
    }
    written += result.bytesWritten;
  }
}

/** Persist a newly created directory entry on platforms where directory fsync is available. */
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") {
    // Node cannot portably open Windows directories for FlushFileBuffers. FileHandle.sync remains
    // the strongest available guarantee there; POSIX requires this additional directory sync.
    return;
  }
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export interface SessionWriter {
  readonly filePath: string;
  readonly meta: SessionMetaLine;
  readonly nextSeq: number;
  append(event: NewSessionEvent, options?: { timestamp?: number }): Promise<LocatedSessionEvent>;
  flush(): Promise<void>;
  close(options?: { flush?: boolean }): Promise<void>;
}

export interface OpenSessionWriterOptions extends SessionStoragePaths {
  traceId?: string;
}

async function prepareEventForStorage(
  event: NewSessionEvent,
  blobOptions: SessionBlobStoreOptions,
): Promise<NewSessionEvent> {
  // Blob references may only become reachable from JSONL after their bytes are durable. Keeping
  // this transformation inside the writer preserves that ordering for every event producer.
  switch (event.type) {
    case "message_recorded":
      return {
        ...event,
        message: await persistMessageImageBlobs(event.message, blobOptions),
      };
    case "context_compacted":
      return {
        ...event,
        replacementHistory: await Promise.all(
          event.replacementHistory.map((message) => persistMessageImageBlobs(message, blobOptions)),
        ),
      };
    case "legacy_snapshot":
      return {
        ...event,
        messages: await Promise.all(
          event.messages.map((message) => persistMessageImageBlobs(message, blobOptions)),
        ),
      };
    default:
      return event;
  }
}

function metaLineBytes(meta: SessionMetaLine): Buffer {
  return Buffer.from(`${JSON.stringify(meta)}\n`, "utf8");
}

async function initializeSessionFile(
  handle: FileHandle,
  filePath: string,
  meta: SessionMetaLine,
): Promise<SessionAppendPosition> {
  // The first newline is the commit boundary for a newly created session. A crash before it leaves
  // only initialization residue, which `inspectSessionForAppend` is allowed to replace.
  const firstLine = metaLineBytes(meta);
  await handle.truncate(0);
  await writeAll(handle, firstLine, 0);
  await handle.sync();
  await syncDirectory(path.dirname(filePath));
  return {
    kind: "append",
    meta,
    validBytes: firstLine.length,
    trailingBytes: 0,
    lastSeq: 0,
  };
}

export async function openSessionWriter(
  metaInput: SessionMetaLine,
  options: OpenSessionWriterOptions = {},
): Promise<SessionWriter> {
  const meta = parseSessionMetaLine(metaInput);
  assertSessionId(meta.sessionId);
  const filePath = resolveV2SessionPath(meta.workspaceRoot, meta.sessionId, options);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const lock = await acquireSessionWriterLock(filePath, options.traceId);

  let handle: FileHandle | undefined;
  try {
    let appendPosition: SessionAppendPosition;
    try {
      handle = await open(filePath, "wx+", 0o600);
      appendPosition = await initializeSessionFile(handle, filePath, meta);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      handle = await open(filePath, "r+");
      const inspected = await inspectSessionForAppend(handle, filePath, meta);
      appendPosition =
        inspected.kind === "initialize"
          ? await initializeSessionFile(handle, filePath, meta)
          : inspected;
      if (appendPosition.trailingBytes > 0) {
        await handle.truncate(appendPosition.validBytes);
        await handle.sync();
      }
    }

    let offset = appendPosition.validBytes;
    let seq = appendPosition.lastSeq + 1;
    let closed = false;
    let accepting = true;
    let writeFailure: unknown;
    let queue: Promise<void> = Promise.resolve();
    let closePromise: Promise<void> | undefined;

    // This queue is the writer's linearization point. Only queued operations may observe or mutate
    // `seq`, `offset`, or the handle, so concurrent callers cannot reserve the same JSONL position.
    function schedule<T>(operation: () => Promise<T>): Promise<T> {
      const run = queue.then(operation);
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    }

    const writer: SessionWriter = {
      filePath,
      meta: appendPosition.meta,
      get nextSeq() {
        return seq;
      },
      async append(event, appendOptions) {
        if (!accepting) {
          throw new Error("Session writer is closed");
        }
        return schedule(async () => {
          if (writeFailure) {
            throw new Error("Session writer cannot continue after a failed append", {
              cause: writeFailure,
            });
          }
          const current = handle;
          if (closed || !current) {
            throw new Error("Session writer is closed");
          }

          const validatedEvent = parseNewSessionEvent(event);
          const storedEvent = await prepareEventForStorage(validatedEvent, options);
          const complete = parseSessionEvent({
            ...storedEvent,
            seq,
            timestamp: appendOptions?.timestamp ?? Date.now(),
          });
          const bytes = Buffer.from(`${JSON.stringify(complete)}\n`, "utf8");
          if (bytes.length > MAX_EVENT_LINE_BYTES) {
            throw new Error(`Session event exceeds ${MAX_EVENT_LINE_BYTES} bytes`);
          }
          const eventOffset = offset;
          try {
            await writeAll(current, bytes, eventOffset);
          } catch (error) {
            // A failed positional write may have written a prefix. Its durable boundary is unknown,
            // so this writer must be reopened and repaired rather than continuing at a guessed offset.
            writeFailure = error;
            throw error;
          }
          offset += bytes.length;
          seq += 1;
          return { event: complete, offset: eventOffset, byteLength: bytes.length };
        });
      },
      async flush() {
        if (!accepting) {
          throw new Error("Session writer is closed");
        }
        return schedule(async () => {
          if (writeFailure) {
            throw new Error("Session writer cannot flush after a failed append", {
              cause: writeFailure,
            });
          }
          const current = handle;
          if (closed || !current) {
            throw new Error("Session writer is closed");
          }
          await current.sync();
        });
      },
      close(closeOptions) {
        if (closePromise) {
          return closePromise;
        }
        accepting = false;
        // Reject new work immediately, then close behind every operation already admitted to the
        // queue. This also prevents close() from invalidating a handle across an append await.
        closePromise = schedule(async () => {
          if (closed) {
            return;
          }
          closed = true;
          const current = handle;
          handle = undefined;
          if (!current) {
            throw new Error("Session writer handle is unavailable");
          }
          let closeError: unknown;
          try {
            if (closeOptions?.flush !== false) {
              await current.sync();
            }
            await current.close();
          } catch (error) {
            closeError = error;
          }
          try {
            await releaseSessionWriterLock(lock);
          } catch (error) {
            closeError ??= error;
          }
          if (closeError) {
            throw closeError;
          }
        });
        return closePromise;
      },
    };
    return writer;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await releaseSessionWriterLock(lock).catch(() => undefined);
    throw error;
  }
}
