import fs from "node:fs";
import { isCompactionBridgeMessage } from "../../../shared/conversation/compactionMessages";
import {
  findLastEvent,
  findLatestSessionStateFromTail,
  readSessionEvents,
  readSessionMetaLine,
  resolveV2SessionPath,
  type SessionStoragePaths,
} from "../journal/sessionJsonlStore";
import { isKnownSessionEvent } from "../model/sessionEvents";
import type { SessionMeta, SessionRecord } from "../model/sessionTypes";
import { buildStoredActiveContext, buildTranscript } from "../projection/sessionHistoryProjection";
import {
  projectSessionSummary,
  projectSessionSummaryFromState,
  type SessionSummary,
} from "../projection/sessionProjection";
import { prepareSessionReplay } from "../projection/sessionReplay";
import { readFailure, type SessionReadResult } from "./sessionReadResult";

const v2Paths = (paths: SessionStoragePaths): SessionStoragePaths => ({
  ...paths,
  journalVersion: 2,
});

function sessionMetaFromSummary(summary: SessionSummary): SessionMeta {
  return {
    id: summary.id,
    workspaceRoot: summary.workspaceRoot,
    title: summary.title,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    turns: summary.userTurns,
    traceIds: summary.traceIds,
    ...(summary.budget ? { budget: summary.budget } : {}),
  };
}

/**
 * Read only the immutable header and bounded tail for picker metadata.
 *
 * `needs_full_replay` means there is no current checkpoint; it is deliberately distinct from a
 * missing file. A state checkpoint is current only when it is also the final complete event, so
 * durable suffix events cannot be hidden from the picker.
 */
export async function readV2SessionMetaFast(
  workspaceRoot: string,
  sessionId: string,
  paths: SessionStoragePaths,
): Promise<SessionReadResult<SessionMeta> | { kind: "needs_full_replay" }> {
  const routed = v2Paths(paths);
  try {
    const [meta, state, lastEvent, fileStat] = await Promise.all([
      readSessionMetaLine(workspaceRoot, sessionId, routed),
      findLatestSessionStateFromTail(workspaceRoot, sessionId, routed),
      findLastEvent(workspaceRoot, sessionId, routed),
      fs.promises.stat(resolveV2SessionPath(workspaceRoot, sessionId, paths)),
    ]);
    if (!state || lastEvent?.seq !== state.event.seq) {
      return { kind: "needs_full_replay" };
    }
    return {
      kind: "found",
      value: sessionMetaFromSummary(
        projectSessionSummaryFromState(meta, state.event, { mtimeMs: fileStat.mtimeMs }),
      ),
    };
  } catch (error) {
    return readFailure(error);
  }
}

/** Full summary replay used when a V2 file has no current bounded state checkpoint. */
export async function readV2SessionMetaFull(
  workspaceRoot: string,
  sessionId: string,
  paths: SessionStoragePaths,
): Promise<SessionReadResult<SessionMeta>> {
  const routed = v2Paths(paths);
  try {
    const stored = await readSessionEvents(workspaceRoot, sessionId, routed);
    const replay = prepareSessionReplay(stored.events);
    const fileStat = await fs.promises.stat(resolveV2SessionPath(workspaceRoot, sessionId, paths));
    return {
      kind: "found",
      value: sessionMetaFromSummary(
        projectSessionSummary(stored.meta, replay, { mtimeMs: fileStat.mtimeMs }),
      ),
    };
  } catch (error) {
    return readFailure(error);
  }
}

/** Strict full V2 load for resume, including active-context and transcript projections. */
export async function readV2Session(
  workspaceRoot: string,
  sessionId: string,
  paths: SessionStoragePaths = {},
): Promise<SessionReadResult<SessionRecord>> {
  const routed = v2Paths(paths);
  try {
    const stored = await readSessionEvents(workspaceRoot, sessionId, routed);
    const replay = prepareSessionReplay(stored.events);
    const fileStat = await fs.promises.stat(resolveV2SessionPath(workspaceRoot, sessionId, paths));
    const summary = projectSessionSummary(stored.meta, replay, { mtimeMs: fileStat.mtimeMs });
    const warnings = stored.events.some(
      (event) =>
        isKnownSessionEvent(event) &&
        event.type === "legacy_snapshot" &&
        event.messages.some((message) => isCompactionBridgeMessage(message)),
    )
      ? [
          "This legacy session was compacted before migration; history discarded by the old format cannot be recovered.",
        ]
      : undefined;
    return {
      kind: "found",
      value: {
        meta: sessionMetaFromSummary(summary),
        messages: buildStoredActiveContext(replay),
        transcript: buildTranscript(replay, { tailTurns: 10 }),
        mcpSelection: [],
        mcpToolGrants: [],
        ...(warnings ? { warnings } : {}),
      },
    };
  } catch (error) {
    return readFailure(error);
  }
}
