import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Message } from "@rejelly/core";
import { getErrnoCode } from "../../../shared/foundation/errno";
import { messageContentToText } from "../../../shared/model/message/content";
import {
  createSessionMetaLine,
  openSessionWriter,
  readSessionEvents,
  resolveV2SessionPath,
  resolveV3SessionPath,
  type SessionStoragePaths,
} from "../journal/sessionJsonlStore";
import { resolveSessionsRoot } from "../journal/sessionPaths";
import {
  type AcquiredSessionWriterLock,
  acquireSessionWriterLock,
  releaseSessionWriterLock,
  SessionWriterLockedError,
} from "../journal/sessionWriterLock";
import { getLegacyUserInputDisplay, parseFrozenUserInputV1 } from "../model/frozenUserInput";
import {
  isKnownSessionEvent,
  type MessageRecordedEvent,
  type NewSessionEvent,
  type SessionEvent,
} from "../model/sessionEvents";
import type { SessionRecord } from "../model/sessionTypes";
import { getSessionImageBlobMetadata } from "../model/storedSessionMessage";
import { readFailure, type SessionReadResult } from "./sessionReadResult";
import { readV2Session } from "./sessionV2Store";
import { readV3Session } from "./sessionV3Store";

export interface LegacyMigrationOptions extends SessionStoragePaths {
  /** Product/client written into the immutable V3 session header. */
  originator: string;
  /** Creating application version written into the immutable V3 session header. */
  appVersion: string;
}

const V2_TO_V3_MIGRATION_TRACE_ID = "session-v2-to-v3-migration";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch (error) {
    if (getErrnoCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function acquireV2MigrationLock(
  v2Path: string,
  v3Path: string,
): Promise<AcquiredSessionWriterLock | undefined> {
  for (;;) {
    if (await pathExists(v3Path)) return undefined;
    try {
      return await acquireSessionWriterLock(v2Path, V2_TO_V3_MIGRATION_TRACE_ID);
    } catch (error) {
      if (
        !(error instanceof SessionWriterLockedError) ||
        error.lockInfo?.traceId !== V2_TO_V3_MIGRATION_TRACE_ID
      ) {
        throw error;
      }
      // The lock protocol deliberately permits simultaneous contenders to both reject. A small,
      // randomized retry lets one migration become the sole reader while real V2 writers still
      // fail immediately above.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5 + Math.floor(Math.random() * 16));
      });
    }
  }
}

/**
 * Build and validate a self-contained V3 legacy boundary in a private staging root, then publish
 * it without replacing a concurrently created V3 file. The source `.json` remains untouched.
 */
export async function migrateLegacySession(
  legacy: SessionRecord,
  options: LegacyMigrationOptions,
): Promise<SessionReadResult<SessionRecord>> {
  const { meta, messages } = legacy;
  const v3Path = resolveV3SessionPath(meta.workspaceRoot, meta.id, options);
  const migrationRoot = path.join(
    options.sessionsRoot ?? resolveSessionsRoot(),
    ".migration",
    `${meta.id}-${process.pid}-${randomUUID()}`,
  );
  const migrationPaths = { ...options, sessionsRoot: migrationRoot };
  const stagedV3Path = resolveV3SessionPath(meta.workspaceRoot, meta.id, migrationPaths);
  let writer: Awaited<ReturnType<typeof openSessionWriter>> | undefined;
  try {
    try {
      await fs.promises.access(v3Path);
      return readV3Session(meta.workspaceRoot, meta.id, options);
    } catch (error) {
      // Only absence starts a migration. Permission and other IO failures must remain visible.
      if (getErrnoCode(error) !== "ENOENT") {
        return readFailure(error);
      }
    }

    writer = await openSessionWriter(
      createSessionMetaLine({
        sessionId: meta.id,
        workspaceRoot: meta.workspaceRoot,
        createdAt: meta.createdAt,
        originator: options.originator,
        appVersion: options.appVersion,
      }),
      migrationPaths,
    );
    await writer.append(
      {
        type: "legacy_snapshot",
        sourceSchemaVersion: 1,
        importedAt: Date.now(),
        legacyMeta: { ...meta },
        messages,
      },
      { timestamp: meta.updatedAt },
    );
    await writer.flush();
    await writer.close();
    writer = undefined;

    const migrated = await readV3Session(meta.workspaceRoot, meta.id, migrationPaths);
    if (migrated.kind !== "found") {
      return migrated;
    }
    if (
      migrated.value.meta.turns !== meta.turns ||
      JSON.stringify(migrated.value.meta.budget) !== JSON.stringify(meta.budget)
    ) {
      return {
        kind: "corrupt",
        error: new Error("Migrated Session V3 projections did not validate"),
      };
    }

    await fs.promises.mkdir(path.dirname(v3Path), { recursive: true });
    try {
      // An exclusive hard-link publish keeps an incomplete migration invisible and never replaces
      // a V3 file concurrently created by another process.
      await fs.promises.link(stagedV3Path, v3Path);
    } catch (error) {
      if (getErrnoCode(error) !== "EEXIST") {
        return readFailure(error);
      }
    }
    return readV3Session(meta.workspaceRoot, meta.id, options);
  } catch (error) {
    return readFailure(error);
  } finally {
    await writer?.close({ flush: false }).catch(() => undefined);
    await fs.promises.rm(migrationRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function removeV2UserMetadata(message: Message): Message {
  const extra = message.extra;
  if (!extra || typeof extra.rejelly !== "object" || extra.rejelly === null) return message;
  const {
    kind: _kind,
    display: _display,
    imageDimensions: _imageDimensions,
    imageBlobs: _imageBlobs,
    ...remainingRejelly
  } = extra.rejelly as Record<string, unknown>;
  const { rejelly: _oldRejelly, ...remainingExtra } = extra;
  const cleanedExtra = {
    ...remainingExtra,
    ...(Object.keys(remainingRejelly).length > 0 ? { rejelly: remainingRejelly } : {}),
  };
  return {
    ...message,
    ...(Object.keys(cleanedExtra).length > 0 ? { extra: cleanedExtra } : { extra: undefined }),
  };
}

function migrateV2UserInputEvent(event: MessageRecordedEvent): NewSessionEvent {
  if (event.source.kind !== "user_input") {
    throw new Error("Expected a V2 user_input message event");
  }
  const display = getLegacyUserInputDisplay(event.message);
  const text = display?.text ?? messageContentToText(event.message.content).trim();
  const imageBlobs = getSessionImageBlobMetadata(event.message);
  if (Array.isArray(event.message.content)) {
    for (const part of event.message.content) {
      if (part.type === "image" && !imageBlobs[part.image.url]) {
        throw new Error(`V2 user image has no durable metadata: ${part.image.url}`);
      }
    }
  }
  const input = parseFrozenUserInputV1({
    version: 1,
    kind: "legacy",
    message: removeV2UserMetadata(event.message),
    display: display ?? { text, attachments: [] },
    imageBlobs,
  });
  return {
    type: "user_input_recorded",
    turnId: event.turnId,
    inputKind: event.source.inputKind,
    input,
  };
}

function migrateKnownV2Event(event: SessionEvent): NewSessionEvent {
  if (!isKnownSessionEvent(event)) {
    throw new Error(`Cannot safely migrate unknown V2 event type: ${event.type}`);
  }
  if (event.type === "message_recorded" && event.source.kind === "user_input") {
    return migrateV2UserInputEvent(event);
  }
  const { seq: _seq, timestamp: _timestamp, ...newEvent } = event;
  return newEvent as NewSessionEvent;
}

function comparableMessage(message: Message): Message {
  if (!message.extra || typeof message.extra.rejelly !== "object" || !message.extra.rejelly) {
    return message;
  }
  const {
    kind: _kind,
    display: _display,
    imageDimensions: _imageDimensions,
    imageBlobs: _imageBlobs,
    ...rejelly
  } = message.extra.rejelly as Record<string, unknown>;
  const { rejelly: _oldRejelly, ...extra } = message.extra;
  const cleanedExtra = { ...extra, ...(Object.keys(rejelly).length > 0 ? { rejelly } : {}) };
  return {
    ...message,
    ...(Object.keys(cleanedExtra).length > 0 ? { extra: cleanedExtra } : { extra: undefined }),
  };
}

function equivalentProjection(left: SessionRecord, right: SessionRecord): boolean {
  const leftMeta = { ...left.meta, updatedAt: 0 };
  const rightMeta = { ...right.meta, updatedAt: 0 };
  return (
    JSON.stringify(leftMeta) === JSON.stringify(rightMeta) &&
    JSON.stringify(left.messages.map(comparableMessage)) ===
      JSON.stringify(right.messages.map(comparableMessage)) &&
    JSON.stringify(left.transcript) === JSON.stringify(right.transcript) &&
    JSON.stringify(left.mcp) === JSON.stringify(right.mcp)
  );
}

/** Migrate a fully validated V2 journal through private V3 staging and exclusive publish. */
export async function migrateV2Session(
  workspaceRoot: string,
  sessionId: string,
  options: LegacyMigrationOptions,
): Promise<SessionReadResult<SessionRecord>> {
  const v3Path = resolveV3SessionPath(workspaceRoot, sessionId, options);
  const migrationRoot = path.join(
    options.sessionsRoot ?? resolveSessionsRoot(),
    ".migration",
    `${sessionId}-v3-${process.pid}-${randomUUID()}`,
  );
  const migrationPaths = { ...options, sessionsRoot: migrationRoot };
  const stagedV3Path = resolveV3SessionPath(workspaceRoot, sessionId, migrationPaths);
  const v2Path = resolveV2SessionPath(workspaceRoot, sessionId, options);
  let writer: Awaited<ReturnType<typeof openSessionWriter>> | undefined;
  let sourceLock: AcquiredSessionWriterLock | undefined;
  try {
    if (await pathExists(v3Path)) {
      return readV3Session(workspaceRoot, sessionId, options);
    }

    sourceLock = await acquireV2MigrationLock(v2Path, v3Path);
    if (!sourceLock) return readV3Session(workspaceRoot, sessionId, options);
    // A winner can publish between the pre-lock existence check and our acquisition.
    if (await pathExists(v3Path)) return readV3Session(workspaceRoot, sessionId, options);

    const source = await readSessionEvents(workspaceRoot, sessionId, {
      ...options,
      journalVersion: 2,
    });
    const sourceProjection = await readV2Session(workspaceRoot, sessionId, options);
    if (sourceProjection.kind !== "found") return sourceProjection;
    writer = await openSessionWriter(
      createSessionMetaLine({
        sessionId,
        workspaceRoot,
        createdAt: source.meta.createdAt,
        originator: options.originator,
        appVersion: options.appVersion,
      }),
      migrationPaths,
    );
    for (const event of source.events) {
      await writer.append(migrateKnownV2Event(event), { timestamp: event.timestamp });
    }
    await writer.flush();
    await writer.close();
    writer = undefined;

    const migrated = await readV3Session(workspaceRoot, sessionId, migrationPaths);
    if (migrated.kind !== "found") return migrated;
    if (!equivalentProjection(sourceProjection.value, migrated.value)) {
      return { kind: "corrupt", error: new Error("V2→V3 projections are not equivalent") };
    }

    await fs.promises.mkdir(path.dirname(v3Path), { recursive: true });
    try {
      await fs.promises.link(stagedV3Path, v3Path);
    } catch (error) {
      if (getErrnoCode(error) !== "EEXIST") return readFailure(error);
    }
    return readV3Session(workspaceRoot, sessionId, options);
  } catch (error) {
    return readFailure(error);
  } finally {
    await writer?.close({ flush: false }).catch(() => undefined);
    try {
      if (sourceLock) await releaseSessionWriterLock(sourceLock);
    } finally {
      await fs.promises.rm(migrationRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
