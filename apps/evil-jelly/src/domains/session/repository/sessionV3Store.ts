import fs from "node:fs";
import { isCompactionBridgeMessage } from "../../../shared/conversation/compactionMessages";
import {
  findLastEvent,
  findLatestSessionStateFromTail,
  readSessionEvents,
  readSessionMetaLine,
  resolveV3SessionPath,
  type SessionStoragePaths,
} from "../journal/sessionJsonlStore";
import { isKnownSessionEvent } from "../model/sessionEvents";
import type { SessionMeta, SessionRecord } from "../model/sessionTypes";
import { projectMcpSessionSelection } from "../projection/mcpSelectionProjection";
import { buildStoredActiveContext, buildTranscript } from "../projection/sessionHistoryProjection";
import {
  projectSessionSummary,
  projectSessionSummaryFromState,
  type SessionSummary,
} from "../projection/sessionProjection";
import { prepareSessionReplay } from "../projection/sessionReplay";
import { readFailure, type SessionReadResult } from "./sessionReadResult";

const v3Paths = (paths: SessionStoragePaths): SessionStoragePaths => ({
  ...paths,
  journalVersion: 3,
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

export async function readV3SessionMetaFast(
  workspaceRoot: string,
  sessionId: string,
  paths: SessionStoragePaths,
): Promise<SessionReadResult<SessionMeta> | { kind: "needs_full_replay" }> {
  const routed = v3Paths(paths);
  try {
    const [meta, state, lastEvent, fileStat] = await Promise.all([
      readSessionMetaLine(workspaceRoot, sessionId, routed),
      findLatestSessionStateFromTail(workspaceRoot, sessionId, routed),
      findLastEvent(workspaceRoot, sessionId, routed),
      fs.promises.stat(resolveV3SessionPath(workspaceRoot, sessionId, routed)),
    ]);
    if (!state || lastEvent?.seq !== state.event.seq) return { kind: "needs_full_replay" };
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

export async function readV3SessionMetaFull(
  workspaceRoot: string,
  sessionId: string,
  paths: SessionStoragePaths,
): Promise<SessionReadResult<SessionMeta>> {
  const routed = v3Paths(paths);
  try {
    const stored = await readSessionEvents(workspaceRoot, sessionId, routed);
    const replay = prepareSessionReplay(stored.events);
    const fileStat = await fs.promises.stat(resolveV3SessionPath(workspaceRoot, sessionId, routed));
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

export async function readV3Session(
  workspaceRoot: string,
  sessionId: string,
  paths: SessionStoragePaths = {},
): Promise<SessionReadResult<SessionRecord>> {
  const routed = v3Paths(paths);
  try {
    const stored = await readSessionEvents(workspaceRoot, sessionId, routed);
    const replay = prepareSessionReplay(stored.events);
    const fileStat = await fs.promises.stat(resolveV3SessionPath(workspaceRoot, sessionId, routed));
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
        mcpSelection: projectMcpSessionSelection(replay),
        ...(warnings ? { warnings } : {}),
      },
    };
  } catch (error) {
    return readFailure(error);
  }
}
