/**
 * Mixed-format session facade.
 *
 * V1/V2 readers preserve missing, corruption, and IO failures as distinct outcomes. This module
 * owns only format priority, fallback, lazy-migration policy, and the stable API consumed by CLI
 * resume flows.
 */

import fs from "node:fs";
import { persistSession, readLegacySession } from "./legacySessionStore";
import type { SessionStoragePaths } from "./sessionJsonlStore";
import { type LegacyMigrationOptions, migrateLegacySession } from "./sessionMigration";
import {
  generateSessionId,
  isValidSessionId,
  resolveSessionsRoot,
  resolveWorkspaceDir,
  workspaceBucket,
} from "./sessionPaths";
import {
  type SessionReadFailureKind,
  type SessionReadResult,
  SessionStoreReadError,
} from "./sessionReadResult";
import type {
  PersistSessionInput,
  SessionBudget,
  SessionMeta,
  SessionRecord,
} from "./sessionTypes";
import { readV2Session, readV2SessionMetaFast, readV2SessionMetaFull } from "./sessionV2Store";

export { persistSession };
export { generateSessionId, resolveSessionsRoot, resolveWorkspaceDir, workspaceBucket };
export { SessionStoreReadError };
export type {
  LegacyMigrationOptions,
  PersistSessionInput,
  SessionBudget,
  SessionMeta,
  SessionRecord,
};

export interface LoadSessionOptions extends SessionStoragePaths {
  /** When present, a V1 fallback is migrated before being returned to a resume caller. */
  migrateLegacy?: {
    originator: string;
    appVersion: string;
  };
}

function warningFor(format: "v1" | "v2", kind: SessionReadFailureKind): string {
  return `The ${format.toUpperCase()} session file is ${kind}; using the compatible fallback.`;
}

function withWarning(record: SessionRecord, warning: string): SessionRecord {
  return {
    ...record,
    warnings: [...(record.warnings ?? []), warning],
  };
}

function throwReadFailure(
  result: Exclude<SessionReadResult<unknown>, { kind: "found" }>,
  format: "v1" | "v2",
  sessionId: string,
): never {
  if (result.kind === "missing") {
    throw new Error("Missing sessions are not exceptional at the facade boundary");
  }
  throw new SessionStoreReadError(result.kind, format, sessionId, result.error);
}

/**
 * Full V2-first resume load.
 *
 * Missing files return `undefined`. Corrupt V2 may fall back to a valid V1 source with an explicit
 * warning; unreadable V2 never falls back because the facade cannot safely establish authority.
 * Without a safe fallback, corrupt and unreadable results throw `SessionStoreReadError`.
 */
export async function loadSession(
  workspaceRoot: string,
  sessionId: string,
  options: LoadSessionOptions = {},
): Promise<SessionRecord | undefined> {
  const v2 = await readV2Session(workspaceRoot, sessionId, options);
  if (v2.kind === "found") {
    return v2.value;
  }
  if (v2.kind === "unreadable") {
    throwReadFailure(v2, "v2", sessionId);
  }

  const legacy = readLegacySession(workspaceRoot, sessionId, options);
  if (legacy.kind !== "found") {
    if (v2.kind === "corrupt") {
      throwReadFailure(v2, "v2", sessionId);
    }
    if (legacy.kind === "missing") {
      return undefined;
    }
    throwReadFailure(legacy, "v1", sessionId);
  }

  if (v2.kind === "corrupt") {
    return withWarning(legacy.value, warningFor("v2", "corrupt"));
  }
  if (!options.migrateLegacy) {
    return legacy.value;
  }

  const migrated = await migrateLegacySession(legacy.value, {
    ...options,
    ...options.migrateLegacy,
  });
  return migrated.kind === "found"
    ? migrated.value
    : withWarning(legacy.value, warningFor("v2", migrated.kind));
}

async function readV2ListingMeta(
  workspaceRoot: string,
  sessionId: string,
  options: SessionStoragePaths,
): Promise<SessionReadResult<SessionMeta>> {
  const fast = await readV2SessionMetaFast(workspaceRoot, sessionId, options);
  return fast.kind === "needs_full_replay"
    ? readV2SessionMetaFull(workspaceRoot, sessionId, options)
    : fast;
}

/**
 * Mixed V1/V2 picker listing, newest first and de-duplicated by session id.
 *
 * V2 normally reads only `session_meta`, a bounded tail checkpoint, the final event, and file
 * metadata. It falls back to strict full replay when no checkpoint covers the complete log.
 * Legacy V1 files must still be parsed in full because their metadata is embedded in one JSON
 * snapshot. Listing never triggers migration.
 */
export async function listSessions(
  workspaceRoot: string,
  options: SessionStoragePaths = {},
): Promise<SessionMeta[]> {
  const dir = resolveWorkspaceDir(workspaceRoot, options.sessionsRoot);
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw new SessionStoreReadError("unreadable", "store", "(session directory)", error);
  }

  const formats = new Map<string, { v1: boolean; v2: boolean }>();
  for (const entry of entries) {
    const match = /^(.*)\.(jsonl?)$/.exec(entry);
    if (!match?.[1] || !match[2]) {
      continue;
    }
    if (!isValidSessionId(match[1])) {
      continue;
    }
    const current = formats.get(match[1]) ?? { v1: false, v2: false };
    if (match[2] === "jsonl") {
      current.v2 = true;
    } else {
      current.v1 = true;
    }
    formats.set(match[1], current);
  }

  const metas = await Promise.all(
    [...formats].map(async ([id, format]) => {
      let v2Failure: Exclude<SessionReadResult<SessionMeta>, { kind: "found" }> | undefined;
      if (format.v2) {
        const v2 = await readV2ListingMeta(workspaceRoot, id, options);
        if (v2.kind === "found") {
          return v2.value;
        }
        if (v2.kind === "unreadable") {
          throwReadFailure(v2, "v2", id);
        }
        v2Failure = v2;
      }

      if (format.v1) {
        const legacy = readLegacySession(workspaceRoot, id, options);
        if (legacy.kind === "found") {
          return legacy.value.meta;
        }
        if (v2Failure?.kind === "corrupt") {
          throwReadFailure(v2Failure, "v2", id);
        }
        if (legacy.kind === "unreadable") {
          throwReadFailure(legacy, "v1", id);
        }
        // A malformed legacy snapshot should not make every other picker entry unavailable.
        // Unlike V2, V1 has no authoritative checkpoint to surface as a placeholder row.
      }

      if (v2Failure?.kind === "corrupt") {
        throwReadFailure(v2Failure, "v2", id);
      }
      return undefined;
    }),
  );
  return metas.flatMap((meta) => (meta ? [meta] : [])).sort((a, b) => b.updatedAt - a.updatedAt);
}
