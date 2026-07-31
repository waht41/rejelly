import path from "node:path";
import type { SessionMetaLine, SessionStateEvent, SessionStatus } from "./sessionEvents";
import type { PreparedSessionReplay } from "./sessionReplay";
import type { SessionBudget } from "./sessionStore";
import { deriveSessionTitle } from "./sessionTitle";

/**
 * Picker/status projection.
 *
 * This is intentionally independent from transcript and active-context projections: compaction
 * changes model memory, but must not change the title, user-turn count, or trace chain shown for
 * the durable session.
 */
export type { PreparedSessionEvent, PreparedSessionReplay } from "./sessionReplay";
export { prepareSessionReplay } from "./sessionReplay";

export interface SessionSummary {
  id: string;
  workspaceRoot: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  userTurns: number;
  traceIds: string[];
  budget?: SessionBudget;
  status: SessionStatus;
  lastSeq: number;
}

export interface SessionFileStat {
  mtimeMs: number;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function projectSessionSummary(
  meta: SessionMetaLine,
  replay: PreparedSessionReplay,
  fileStat?: SessionFileStat,
): SessionSummary {
  // A valid state checkpoint replaces the accumulated summary through its preceding seq. Events
  // after it still replay normally, which covers crashes between a business event and the next
  // checkpoint without making session_state a correctness dependency.
  let title = "(untitled)";
  let userTurns = 0;
  let budget: SessionBudget | undefined;
  let status: SessionStatus = "idle";
  const traceIds: string[] = [];
  const userTurnIds = new Set<string>();

  for (const event of replay.events) {
    switch (event.type) {
      case "legacy_snapshot": {
        title = event.legacyMeta.title || title;
        userTurns = event.legacyMeta.turns;
        budget = event.legacyMeta.budget;
        traceIds.push(...event.legacyMeta.traceIds);
        break;
      }
      case "run_segment_started":
        traceIds.push(event.traceId);
        status = "active";
        break;
      case "run_segment_ended":
        status =
          event.status === "completed"
            ? "idle"
            : event.status === "error"
              ? "error"
              : "interrupted";
        break;
      case "message_recorded":
        if (
          event.source.kind === "user_input" &&
          event.source.inputKind === "initial" &&
          !userTurnIds.has(event.turnId)
        ) {
          userTurnIds.add(event.turnId);
          userTurns += 1;
          title = title === "(untitled)" ? (deriveSessionTitle(event.message) ?? title) : title;
        }
        break;
      case "turn_completed":
        if (event.status === "error") {
          status = "error";
        } else if (event.status === "interrupted") {
          status = "interrupted";
        }
        break;
      case "context_compacted":
        // Active-context boundary only; it does not change picker/summary metadata.
        break;
      case "budget_updated":
        budget = event.budget;
        break;
      case "session_state":
        // The writer contract emits state immediately after the events it covers. Reject a
        // structurally valid but misplaced checkpoint rather than letting it erase suffix state.
        if (event.coveredThroughSeq !== event.seq - 1) {
          break;
        }
        title = event.title || title;
        userTurns = event.userTurns;
        budget = event.budget ?? budget;
        status = event.status;
        traceIds.splice(0, traceIds.length, ...event.traceIds);
        break;
      default:
        break;
    }
  }

  return {
    id: meta.sessionId,
    workspaceRoot: path.resolve(meta.workspaceRoot),
    title,
    createdAt: meta.createdAt,
    updatedAt: fileStat?.mtimeMs ?? replay.lastTimestamp ?? meta.createdAt,
    userTurns,
    traceIds: unique(traceIds),
    budget,
    status,
    lastSeq: replay.lastSeq,
  };
}

/**
 * Bounded listing fast path. Callers may use this only after the tail reader has validated the
 * checkpoint pointer; otherwise they must fall back to projectSessionSummary over a replay.
 */
export function projectSessionSummaryFromState(
  meta: SessionMetaLine,
  state: SessionStateEvent,
  fileStat?: SessionFileStat,
): SessionSummary {
  return {
    id: meta.sessionId,
    workspaceRoot: path.resolve(meta.workspaceRoot),
    title: state.title || "(untitled)",
    createdAt: meta.createdAt,
    updatedAt: fileStat?.mtimeMs ?? state.timestamp,
    userTurns: state.userTurns,
    traceIds: unique(state.traceIds),
    budget: state.budget,
    status: state.status,
    lastSeq: state.seq,
  };
}
