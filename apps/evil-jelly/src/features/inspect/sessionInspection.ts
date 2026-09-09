import {
  isKnownSessionEvent,
  type SessionBudgetData,
  type SessionEvent,
  type SessionMetaLine,
} from "../../domains/session/model/sessionEvents";

export type InspectedTurnStatus = "in_progress" | "completed" | "interrupted" | "error";

export interface TurnInspection {
  turnId: string;
  firstSeq: number;
  startedAt: number;
  endedAt?: number;
  status: InspectedTurnStatus;
  modelCalls: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Cached prompt tokens divided by all prompt tokens. */
  cacheHitRate: number;
  modelDurationMs: number;
  toolDurationMs: number;
  toolOutputBytes: number;
  canonicalToolResultBytes: number;
  transportFailures: number;
  outcomes: Partial<Record<"succeeded" | "failed" | "denied" | "aborted" | "timed_out", number>>;
  compactions: number;
}

export interface SessionInspectionTotals {
  modelCalls: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Cached prompt tokens divided by all prompt tokens. */
  cacheHitRate: number;
  modelDurationMs: number;
  toolDurationMs: number;
  toolOutputBytes: number;
  canonicalToolResultBytes: number;
  transportFailures: number;
  compactions: number;
  costs: Record<string, number>;
}

export interface SessionInspection {
  type: "session_inspection_v1";
  sessionId: string;
  workspaceRoot: string;
  createdAt: number;
  title: string;
  status: "active" | "idle" | "interrupted" | "error";
  eventCount: number;
  completedTurns: number;
  inProgressTurns: number;
  totals: SessionInspectionTotals;
  budgetCheckpoint?: SessionBudgetData;
  unattributedModelCalls: number;
  unattributedToolCalls: number;
  turns: TurnInspection[];
  warnings: string[];
}

function emptyTotals(): SessionInspectionTotals {
  return {
    modelCalls: 0,
    toolCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheHitRate: 0,
    modelDurationMs: 0,
    toolDurationMs: 0,
    toolOutputBytes: 0,
    canonicalToolResultBytes: 0,
    transportFailures: 0,
    compactions: 0,
    costs: {},
  };
}

function createTurn(turnId: string, seq: number, timestamp: number): TurnInspection {
  return {
    turnId,
    firstSeq: seq,
    startedAt: timestamp,
    status: "in_progress",
    modelCalls: 0,
    toolCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheHitRate: 0,
    modelDurationMs: 0,
    toolDurationMs: 0,
    toolOutputBytes: 0,
    canonicalToolResultBytes: 0,
    transportFailures: 0,
    outcomes: {},
    compactions: 0,
  };
}

function addCosts(target: Record<string, number>, costs: Record<string, number> | undefined): void {
  if (!costs) return;
  for (const [unit, value] of Object.entries(costs)) {
    target[unit] = (target[unit] ?? 0) + value;
  }
}

export function projectSessionInspection(
  meta: SessionMetaLine,
  events: readonly SessionEvent[],
  readWarnings: readonly string[] = [],
): SessionInspection {
  const totals = emptyTotals();
  const turns = new Map<string, TurnInspection>();
  const warnings = [...readWarnings];
  let title = "(untitled)";
  let status: SessionInspection["status"] = "idle";
  let budgetCheckpoint: SessionBudgetData | undefined;
  let unattributedModelCalls = 0;
  let unattributedToolCalls = 0;

  const turnFor = (turnId: string, seq: number, timestamp: number): TurnInspection => {
    const existing = turns.get(turnId);
    if (existing) return existing;
    const created = createTurn(turnId, seq, timestamp);
    turns.set(turnId, created);
    return created;
  };

  for (const event of events) {
    if (!isKnownSessionEvent(event)) continue;
    switch (event.type) {
      case "run_segment_started":
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
      case "user_input_recorded":
      case "message_recorded":
      case "tool_observation_recorded":
        turnFor(event.turnId, event.seq, event.timestamp);
        break;
      case "model_call_completed": {
        totals.modelCalls += 1;
        totals.modelDurationMs += event.durationMs;
        totals.promptTokens += event.usage?.promptTokens ?? 0;
        totals.completionTokens += event.usage?.completionTokens ?? 0;
        totals.reasoningTokens += event.usage?.reasoningTokens ?? 0;
        totals.cacheReadTokens += event.usage?.cacheReadTokens ?? 0;
        totals.cacheWriteTokens += event.usage?.cacheWriteTokens ?? 0;
        addCosts(totals.costs, event.costs);
        if (!event.turnId) {
          unattributedModelCalls += 1;
          break;
        }
        const turn = turnFor(event.turnId, event.seq, event.timestamp);
        turn.modelCalls += 1;
        turn.modelDurationMs += event.durationMs;
        turn.promptTokens += event.usage?.promptTokens ?? 0;
        turn.completionTokens += event.usage?.completionTokens ?? 0;
        turn.reasoningTokens += event.usage?.reasoningTokens ?? 0;
        turn.cacheReadTokens += event.usage?.cacheReadTokens ?? 0;
        turn.cacheWriteTokens += event.usage?.cacheWriteTokens ?? 0;
        break;
      }
      case "tool_call_completed": {
        totals.toolCalls += 1;
        totals.toolDurationMs += event.durationMs;
        totals.toolOutputBytes += event.outputBytes;
        totals.canonicalToolResultBytes += event.admittedResultBytes ?? 0;
        if (!event.transportOk) totals.transportFailures += 1;
        if (!event.turnId) {
          unattributedToolCalls += 1;
          break;
        }
        const turn = turnFor(event.turnId, event.seq, event.timestamp);
        turn.toolCalls += 1;
        turn.toolDurationMs += event.durationMs;
        turn.toolOutputBytes += event.outputBytes;
        turn.canonicalToolResultBytes += event.admittedResultBytes ?? 0;
        if (!event.transportOk) turn.transportFailures += 1;
        if (event.outcome) turn.outcomes[event.outcome] = (turn.outcomes[event.outcome] ?? 0) + 1;
        break;
      }
      case "turn_completed": {
        const turn = turnFor(event.turnId, event.seq, event.timestamp);
        turn.status = event.status;
        turn.endedAt = event.timestamp;
        break;
      }
      case "context_compacted":
        totals.compactions += 1;
        if (event.activeTurnId) {
          turnFor(event.activeTurnId, event.seq, event.timestamp).compactions += 1;
        }
        break;
      case "budget_updated":
        budgetCheckpoint = event.budget;
        break;
      case "session_state":
        title = event.title || title;
        status = event.status;
        budgetCheckpoint = event.budget ?? budgetCheckpoint;
        break;
      default:
        break;
    }
  }

  const projectedTurns = [...turns.values()].sort((left, right) => left.firstSeq - right.firstSeq);
  totals.cacheHitRate = totals.promptTokens > 0 ? totals.cacheReadTokens / totals.promptTokens : 0;
  for (const turn of projectedTurns) {
    turn.cacheHitRate = turn.promptTokens > 0 ? turn.cacheReadTokens / turn.promptTokens : 0;
  }
  if (totals.modelCalls === 0) warnings.push("No model_call_completed events were recorded.");
  if (unattributedModelCalls > 0 || unattributedToolCalls > 0) {
    warnings.push(
      `${unattributedModelCalls} model call(s) and ${unattributedToolCalls} tool call(s) are outside a user turn.`,
    );
  }

  return {
    type: "session_inspection_v1",
    sessionId: meta.sessionId,
    workspaceRoot: meta.workspaceRoot,
    createdAt: meta.createdAt,
    title,
    status,
    eventCount: events.length,
    completedTurns: projectedTurns.filter((turn) => turn.status !== "in_progress").length,
    inProgressTurns: projectedTurns.filter((turn) => turn.status === "in_progress").length,
    totals,
    ...(budgetCheckpoint ? { budgetCheckpoint } : {}),
    unattributedModelCalls,
    unattributedToolCalls,
    turns: projectedTurns,
    warnings,
  };
}
