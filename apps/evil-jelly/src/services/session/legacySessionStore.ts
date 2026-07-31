import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  countConversationTurns,
  isCompactionBridgeMessage,
} from "../../shared/lib/compactionMessages";
import { sessionBudgetSchema, sessionMessageSchema } from "./sessionEvents";
import type { SessionStoragePaths } from "./sessionJsonlStore";
import { resolveWorkspaceDir } from "./sessionPaths";
import { readFailure, type SessionReadResult } from "./sessionReadResult";
import { deriveSessionTitleFromMessages } from "./sessionTitle";
import type { PersistSessionInput, SessionMeta, SessionRecord } from "./sessionTypes";

const legacyMetaSchema = z
  .object({
    id: z.string().min(1),
    workspaceRoot: z.string(),
    title: z.string(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    turns: z.number().int().nonnegative(),
    traceIds: z.array(z.string()),
    budget: sessionBudgetSchema.optional(),
  })
  .passthrough();

const legacyRecordSchema = z.object({
  meta: legacyMetaSchema,
  messages: z.array(sessionMessageSchema),
});

export function resolveLegacySessionPath(
  workspaceRoot: string,
  sessionId: string,
  paths: SessionStoragePaths = {},
): string {
  return path.join(resolveWorkspaceDir(workspaceRoot, paths.sessionsRoot), `${sessionId}.json`);
}

/** Read and validate one complete legacy snapshot. V1 has no bounded metadata-only representation. */
export function readLegacySession(
  workspaceRoot: string,
  sessionId: string,
  paths: SessionStoragePaths = {},
): SessionReadResult<SessionRecord> {
  try {
    const parsed = legacyRecordSchema.parse(
      JSON.parse(
        fs.readFileSync(resolveLegacySessionPath(workspaceRoot, sessionId, paths), "utf8"),
      ),
    );
    if (
      parsed.meta.id !== sessionId ||
      path.resolve(parsed.meta.workspaceRoot) !== path.resolve(workspaceRoot)
    ) {
      return {
        kind: "corrupt",
        error: new Error(`Legacy session identity does not match ${sessionId}`),
      };
    }
    return {
      kind: "found",
      value: {
        meta: {
          ...parsed.meta,
          workspaceRoot: path.resolve(parsed.meta.workspaceRoot),
          // Older V1 records counted the synthetic compaction bridge as a user turn.
          turns: countConversationTurns(parsed.messages),
        },
        messages: parsed.messages,
        storageVersion: 1,
        ...(parsed.messages.some(isCompactionBridgeMessage)
          ? {
              warnings: [
                "This legacy session was compacted before migration; history discarded by the old format cannot be recovered.",
              ],
            }
          : {}),
      },
    };
  } catch (error) {
    return readFailure(error);
  }
}

/**
 * Best-effort compatibility V1 writer.
 *
 * New CLI sessions use SessionRecorder/V2. This fallback preserves V1 behavior after a migration
 * failure: merge stable metadata, write a complete temporary snapshot, then rename it into place.
 * It never throws into the conversation turn.
 */
export function persistSession(input: PersistSessionInput): void {
  try {
    const paths = input.sessionsRoot ? { sessionsRoot: input.sessionsRoot } : {};
    const filePath = resolveLegacySessionPath(input.workspaceRoot, input.sessionId, paths);
    const existingResult = readLegacySession(input.workspaceRoot, input.sessionId, paths);
    const existing = existingResult.kind === "found" ? existingResult.value : undefined;
    const now = Date.now();
    const traceIds = new Set(existing?.meta.traceIds ?? []);
    if (input.traceId) {
      traceIds.add(input.traceId);
    }
    const meta: SessionMeta = {
      id: input.sessionId,
      workspaceRoot: path.resolve(input.workspaceRoot),
      title: existing?.meta.title ?? deriveSessionTitleFromMessages(input.messages),
      createdAt: existing?.meta.createdAt ?? now,
      updatedAt: now,
      turns: countConversationTurns(input.messages),
      traceIds: [...traceIds],
      budget: input.budget ?? existing?.meta.budget,
    };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ meta, messages: input.messages }, null, 2), "utf8");
    fs.renameSync(tmp, filePath);
  } catch {
    // Persistence is best-effort; a failed write must not break the turn.
  }
}
