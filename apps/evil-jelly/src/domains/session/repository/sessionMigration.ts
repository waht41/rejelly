import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getErrnoCode } from "../../../shared/lib/errors";
import {
  createSessionMetaLine,
  openSessionWriter,
  resolveV2SessionPath,
  type SessionStoragePaths,
} from "../journal/sessionJsonlStore";
import { resolveSessionsRoot } from "../journal/sessionPaths";
import type { SessionRecord } from "../model/sessionTypes";
import { readFailure, type SessionReadResult } from "./sessionReadResult";
import { readV2Session } from "./sessionV2Store";

export interface LegacyMigrationOptions extends SessionStoragePaths {
  /** Product/client written into the immutable V2 session header. */
  originator: string;
  /** Creating application version written into the immutable V2 session header. */
  appVersion: string;
}

/**
 * Build and validate a self-contained V2 legacy boundary in a private staging root, then publish
 * it without replacing a concurrently created V2 file. The source `.json` remains untouched.
 */
export async function migrateLegacySession(
  legacy: SessionRecord,
  options: LegacyMigrationOptions,
): Promise<SessionReadResult<SessionRecord>> {
  const { meta, messages } = legacy;
  const v2Path = resolveV2SessionPath(meta.workspaceRoot, meta.id, options);
  const migrationRoot = path.join(
    options.sessionsRoot ?? resolveSessionsRoot(),
    ".migration",
    `${meta.id}-${process.pid}-${randomUUID()}`,
  );
  const migrationPaths = { ...options, sessionsRoot: migrationRoot };
  const stagedV2Path = resolveV2SessionPath(meta.workspaceRoot, meta.id, migrationPaths);
  let writer: Awaited<ReturnType<typeof openSessionWriter>> | undefined;
  try {
    try {
      await fs.promises.access(v2Path);
      return readV2Session(meta.workspaceRoot, meta.id, options);
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

    const migrated = await readV2Session(meta.workspaceRoot, meta.id, migrationPaths);
    if (migrated.kind !== "found") {
      return migrated;
    }
    if (
      migrated.value.meta.turns !== meta.turns ||
      JSON.stringify(migrated.value.meta.budget) !== JSON.stringify(meta.budget)
    ) {
      return {
        kind: "corrupt",
        error: new Error("Migrated Session V2 projections did not validate"),
      };
    }

    await fs.promises.mkdir(path.dirname(v2Path), { recursive: true });
    try {
      // An exclusive hard-link publish keeps an incomplete migration invisible and never replaces
      // a V2 file concurrently created by another process.
      await fs.promises.link(stagedV2Path, v2Path);
    } catch (error) {
      if (getErrnoCode(error) !== "EEXIST") {
        return readFailure(error);
      }
    }
    return readV2Session(meta.workspaceRoot, meta.id, options);
  } catch (error) {
    return readFailure(error);
  } finally {
    await writer?.close({ flush: false }).catch(() => undefined);
    await fs.promises.rm(migrationRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
