/**
 * Mixed-format session facade.
 *
 * V1/V2 readers preserve missing, corruption, and IO failures as distinct outcomes. This module
 * owns only format priority, fallback, lazy-migration policy, and the stable API consumed by CLI
 * resume flows.
 */

import fs from "node:fs";
import type { SessionStoragePaths } from "../journal/sessionJsonlReader";
import { generateSessionId, isValidSessionId, resolveWorkspaceDir } from "../journal/sessionPaths";
import type { SessionBudget, SessionMeta, SessionRecord } from "../model/sessionTypes";
import { readLegacySession } from "./legacySessionStore";
import { type LegacyMigrationOptions, migrateLegacySession } from "./sessionMigration";
import { type SessionReadResult, SessionStoreReadError } from "./sessionReadResult";
import { readV2Session, readV2SessionMetaFast, readV2SessionMetaFull } from "./sessionV2Store";

export { generateSessionId };
export type { LegacyMigrationOptions, SessionBudget, SessionMeta, SessionRecord };

export type LoadSessionOptions = SessionStoragePaths;

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
 * Read one session without mutating storage.
 *
 * V2 is authoritative whenever present: corrupt or unreadable V2 never falls back to V1. A V1
 * record is returned only when V2 is genuinely missing, primarily for listing and migration
 * preflight. Runtime resume must use `resumeSession`, which guarantees a validated V2 result.
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
  if (v2.kind !== "missing") {
    throwReadFailure(v2, "v2", sessionId);
  }

  const legacy = readLegacySession(workspaceRoot, sessionId, options);
  if (legacy.kind === "found") {
    return legacy.value;
  }
  if (legacy.kind === "missing") {
    return undefined;
  }
  throwReadFailure(legacy, "v1", sessionId);
}

/**
 * Resolve a session for model execution.
 *
 * This is the only runtime resume entry point. It returns only validated V2 data: a legacy V1
 * source must migrate successfully, and every corrupt/unreadable/migration failure aborts resume.
 */
export async function resumeSession(
  workspaceRoot: string,
  sessionId: string,
  options: LegacyMigrationOptions,
): Promise<SessionRecord | undefined> {
  const v2 = await readV2Session(workspaceRoot, sessionId, options);
  if (v2.kind === "found") {
    return v2.value;
  }
  if (v2.kind !== "missing") {
    throwReadFailure(v2, "v2", sessionId);
  }

  const legacy = readLegacySession(workspaceRoot, sessionId, options);
  if (legacy.kind === "missing") {
    return undefined;
  }
  if (legacy.kind !== "found") {
    throwReadFailure(legacy, "v1", sessionId);
  }

  const migrated = await migrateLegacySession(legacy.value, options);
  if (migrated.kind === "found") {
    return migrated.value;
  }
  if (migrated.kind === "missing") {
    throw new SessionStoreReadError(
      "corrupt",
      "v2",
      sessionId,
      new Error("Migration completed without a readable V2 session"),
    );
  }
  throwReadFailure(migrated, "v2", sessionId);
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
