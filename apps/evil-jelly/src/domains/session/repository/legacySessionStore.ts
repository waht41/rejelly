import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  countConversationTurns,
  isCompactionBridgeMessage,
} from "../../../shared/conversation/compactionMessages";
import { emptySessionMcpState } from "../../../shared/model/mcp/sessionMcpState";
import type { SessionStoragePaths } from "../journal/sessionJsonlReader";
import { resolveWorkspaceDir } from "../journal/sessionPaths";
import { legacySessionMetaSchema, sessionMessageSchema } from "../model/sessionEvents";
import type { SessionRecord } from "../model/sessionTypes";
import { readFailure, type SessionReadResult } from "./sessionReadResult";

const legacyRecordSchema = z.object({
  meta: legacySessionMetaSchema,
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
        mcp: emptySessionMcpState(),
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
