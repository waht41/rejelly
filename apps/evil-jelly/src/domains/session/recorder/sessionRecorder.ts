import type { Message } from "@rejelly/core";
import {
  type FrozenUserInputV1,
  projectFrozenUserInputPlainText,
  type ResolvedUserInputV1,
} from "../../../shared/model/prompt/frozenUserInput";
import type { NonUserMessageSource } from "../../../shared/session/messageSource";
import type {
  SessionCompactionRecord,
  SessionMessageSink,
} from "../../../shared/session/recorderPort";
import {
  createSessionMetaLine,
  type LocatedSessionEvent,
  openSessionWriter,
  readSessionEvents,
  type SessionStoragePaths,
  type SessionWriter,
} from "../journal/sessionJsonlStore";
import { freezeResolvedUserInput } from "../journal/userInputStorage";
import type { NewSessionEvent, SessionEvent, SessionStatus } from "../model/sessionEvents";
import { isKnownSessionEvent } from "../model/sessionEvents";
import type { SessionBudget } from "../model/sessionTypes";
import { projectSessionSummary } from "../projection/sessionProjection";
import {
  findIncompleteTurnRecoveries,
  type IncompleteTurnRecovery,
  UNKNOWN_TOOL_OUTCOME_CONTENT,
} from "../projection/sessionRecovery";
import { prepareSessionReplay } from "../projection/sessionReplay";
import { deriveSessionTitleFromText } from "../projection/sessionTitle";

/**
 * Runtime write-side coordinator for Session V3.
 *
 * The JSONL writer owns byte ordering and locking; this recorder adds conversation semantics:
 * durable item/round boundaries, turn/segment closure, and incremental `session_state`
 * checkpoints. It never treats compacted context as a replacement for transcript events.
 */
/**
 * Awaited durable observer shared by MainCliAgent and the tool loop.
 *
 * The message-write half is the shared {@link SessionMessageSink} port; the turn/segment lifecycle
 * added here is driven only by the shell.
 *
 * A method resolves only after its complete item/round batch has reached the file's durable
 * boundary. Callers must pass only immutable, completed messages.
 */
export interface SessionRecorder extends SessionMessageSink {
  readonly sessionId: string;
  readonly traceId: string;
  readonly ended: boolean;
  recordUserInput(
    turnId: string,
    inputKind: "initial" | "steer",
    input: ResolvedUserInputV1,
  ): Promise<FrozenUserInputV1>;
  completeTurn(
    turnId: string,
    status: "completed" | "interrupted" | "error",
    budget?: SessionBudget,
  ): Promise<void>;
  endSegment(input: {
    status: "completed" | "interrupted" | "error";
    reason: "exit" | "switch_session" | "new_session" | "abort" | "error";
    errorMessage?: string;
    budget?: SessionBudget;
  }): Promise<void>;
  close(): Promise<void>;
}

export interface OpenSessionRecorderOptions extends SessionStoragePaths {
  workspaceRoot: string;
  sessionId: string;
  traceId: string;
  originator: string;
  appVersion: string;
  modelId: string;
  provider?: string;
  cwd: string;
  gitBranch?: string;
  gitHead?: string;
}

class JsonlSessionRecorder implements SessionRecorder {
  readonly sessionId: string;
  readonly traceId: string;

  // Lifecycle guards have different meanings: ended means the semantic segment-end event was
  // requested; closed means the underlying writer no longer accepts any event.
  #ended = false;
  #closed = false;

  // Tail-index hints copied into each state checkpoint. They accelerate future projection but are
  // never correctness boundaries; readers still replay complete suffix events.
  #lastCompactSeq: number | undefined;
  #lastCompactOffset: number | undefined;

  // Incremental summary accumulator. Rebuilding this from the entire log at every completed turn
  // would turn an append-only session into O(total history) work per checkpoint.
  #userTurns: number;
  #title: string;
  #traceIds: string[];
  #budget: SessionBudget | undefined;

  // A recorder instance only sees newly appended turns. This set prevents a duplicated initial
  // input callback from incrementing the checkpoint count twice without retaining all old turn ids.
  readonly #newUserTurnIds = new Set<string>();

  constructor(
    private readonly writer: SessionWriter,
    events: SessionEvent[],
    private readonly storagePaths: SessionStoragePaths,
  ) {
    this.sessionId = writer.meta.sessionId;
    // Bootstrap the incremental accumulator once from the authoritative replay. The newly appended
    // run_segment_started event is already present, so traceIds/status match the open segment.
    const started = [...events]
      .reverse()
      .find((event) => isKnownSessionEvent(event) && event.type === "run_segment_started");
    if (!started || !isKnownSessionEvent(started) || started.type !== "run_segment_started") {
      throw new Error("Session recorder requires a run_segment_started event");
    }
    this.traceId = started.traceId;
    const summary = projectSessionSummary(writer.meta, prepareSessionReplay(events));
    this.#userTurns = summary.userTurns;
    this.#title = summary.title;
    this.#traceIds = summary.traceIds;
    this.#budget = summary.budget;
    const priorCompactState = [...events]
      .reverse()
      .find(
        (event) =>
          isKnownSessionEvent(event) &&
          event.type === "session_state" &&
          event.lastCompactSeq !== undefined,
      );
    if (
      priorCompactState &&
      isKnownSessionEvent(priorCompactState) &&
      priorCompactState.type === "session_state"
    ) {
      this.#lastCompactSeq = priorCompactState.lastCompactSeq;
      this.#lastCompactOffset = priorCompactState.lastCompactOffset;
    }
  }

  get ended(): boolean {
    return this.#ended;
  }

  async #append(event: NewSessionEvent): Promise<LocatedSessionEvent> {
    if (this.#closed) {
      throw new Error("Session recorder is closed");
    }
    const located = await this.writer.append(event);
    return located;
  }

  async #checkpoint(status: SessionStatus, budget?: SessionBudget): Promise<void> {
    // coveredThroughSeq deliberately points to the preceding business event. The state event cannot
    // cover itself, otherwise a reader could not validate the checkpoint without a circular rule.
    const coveredThroughSeq = this.writer.nextSeq - 1;
    this.#budget = budget ?? this.#budget;
    await this.#append({
      type: "session_state",
      coveredThroughSeq,
      userTurns: this.#userTurns,
      title: this.#title,
      ...(this.#lastCompactSeq ? { lastCompactSeq: this.#lastCompactSeq } : {}),
      ...(this.#lastCompactOffset !== undefined
        ? { lastCompactOffset: this.#lastCompactOffset }
        : {}),
      traceIds: this.#traceIds,
      ...(this.#budget ? { budget: this.#budget } : {}),
      status,
    });
  }

  async recordUserInput(
    turnId: string,
    inputKind: "initial" | "steer",
    input: ResolvedUserInputV1,
  ): Promise<FrozenUserInputV1> {
    const frozen = await freezeResolvedUserInput(input, this.storagePaths);
    await this.#append({
      type: "user_input_recorded",
      turnId,
      inputKind,
      input: frozen,
    });
    if (inputKind === "initial" && !this.#newUserTurnIds.has(turnId)) {
      this.#newUserTurnIds.add(turnId);
      this.#userTurns += 1;
      if (this.#title === "(untitled)") {
        this.#title =
          deriveSessionTitleFromText(projectFrozenUserInputPlainText(frozen)) ?? this.#title;
      }
    }
    await this.writer.flush();
    return frozen;
  }

  async recordMessage(
    turnId: string,
    source: NonUserMessageSource,
    message: Message,
  ): Promise<void> {
    await this.recordMessages(turnId, [{ source, message }]);
  }

  async recordMessages(
    turnId: string,
    entries: readonly { source: NonUserMessageSource; message: Message }[],
  ): Promise<void> {
    // A model validation round may contain more than one stable message. Append the whole batch in
    // order, then flush once; no streaming snapshot is admitted through this API.
    for (const entry of entries) {
      await this.#append({
        type: "message_recorded",
        turnId,
        source: entry.source,
        message: entry.message,
      });
    }
    if (entries.length > 0) {
      await this.writer.flush();
    }
  }

  async recordCompaction(record: SessionCompactionRecord): Promise<void> {
    // Commit the active-context replacement first, then its indexable state checkpoint. Original
    // message_recorded events remain untouched and continue to drive the transcript projection.
    const compact = await this.#append({
      type: "context_compacted",
      ...record,
      afterMessageCount: record.replacementHistory.length,
    });
    this.#lastCompactSeq = compact.event.seq;
    this.#lastCompactOffset = compact.offset;
    await this.#checkpoint("active");
    await this.writer.flush();
  }

  async completeTurn(
    turnId: string,
    status: "completed" | "interrupted" | "error",
    budget?: SessionBudget,
  ): Promise<void> {
    // Budget and turn closure are one durable batch. A crash before the final state is still safe:
    // the reader replays these complete suffix events from the previous checkpoint.
    if (budget) {
      await this.#append({ type: "budget_updated", budget });
      this.#budget = budget;
    }
    await this.#append({ type: "turn_completed", turnId, status });
    await this.#checkpoint(status === "completed" ? "active" : status);
    await this.writer.flush();
  }

  async recoverInterruptedTurns(recoveries: readonly IncompleteTurnRecovery[]): Promise<void> {
    for (const recovery of recoveries) {
      if (recovery.missingToolCalls.length > 0) {
        await this.recordMessages(
          recovery.turnId,
          recovery.missingToolCalls.map((toolCall) => ({
            source: { kind: "recovery" } as const,
            message: {
              role: "tool" as const,
              tool_call_id: toolCall.id,
              name: toolCall.name,
              content: UNKNOWN_TOOL_OUTCOME_CONTENT,
              extra: { rejelly: { kind: "session_recovery" } },
            },
          })),
        );
      }
      await this.completeTurn(recovery.turnId, "interrupted");
    }
  }

  async endSegment(input: {
    status: "completed" | "interrupted" | "error";
    reason: "exit" | "switch_session" | "new_session" | "abort" | "error";
    errorMessage?: string;
    budget?: SessionBudget;
  }): Promise<void> {
    // MainCliAgent handles explicit exit/switch/clear, while runHost provides the exception/abort
    // fallback. Idempotence keeps those two ownership layers from writing duplicate segment ends.
    if (this.#ended) {
      return;
    }
    this.#ended = true;
    await this.#append({
      type: "run_segment_ended",
      traceId: this.traceId,
      status: input.status,
      reason: input.reason,
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
    });
    await this.#checkpoint(
      input.status === "completed"
        ? "idle"
        : input.status === "interrupted"
          ? "interrupted"
          : "error",
      input.budget,
    );
    await this.writer.flush();
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.writer.close();
  }
}

export async function openSessionRecorder(
  options: OpenSessionRecorderOptions,
): Promise<SessionRecorder> {
  const meta = createSessionMetaLine({
    sessionId: options.sessionId,
    workspaceRoot: options.workspaceRoot,
    originator: options.originator,
    appVersion: options.appVersion,
  });
  // Opening acquires the single-writer lock and repairs an incomplete tail before the full replay.
  // Reading only after that point avoids bootstrapping summary state from a concurrently changing
  // prefix. The file may be newly initialized, in which case the replay is simply empty.
  const writer = await openSessionWriter(meta, { ...options, traceId: options.traceId });
  try {
    const v3Paths = { ...options, journalVersion: 3 as const };
    const stored = await readSessionEvents(options.workspaceRoot, options.sessionId, v3Paths);
    const events = [...stored.events];
    const recoveries = findIncompleteTurnRecoveries(events);
    const hasPriorSegment = events.some(
      (event) => isKnownSessionEvent(event) && event.type === "run_segment_started",
    );
    const started = await writer.append({
      type: "run_segment_started",
      kind: hasPriorSegment ? "resumed" : "created",
      traceId: options.traceId,
      ...(options.provider ? { provider: options.provider } : {}),
      modelId: options.modelId,
      cwd: options.cwd,
      ...(options.gitBranch ? { gitBranch: options.gitBranch } : {}),
      ...(options.gitHead ? { gitHead: options.gitHead } : {}),
    });
    events.push(started.event);
    await writer.flush();
    const recorder = new JsonlSessionRecorder(writer, events, v3Paths);
    await recorder.recoverInterruptedTurns(recoveries);
    return recorder;
  } catch (error) {
    await writer.close().catch(() => undefined);
    throw error;
  }
}
