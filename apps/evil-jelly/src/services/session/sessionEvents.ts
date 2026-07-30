import type { Message } from "@rejelly/core";
import { z } from "zod";

export const SESSION_SCHEMA_VERSION = 2 as const;

const jsonObjectSchema = z.record(z.string(), z.unknown());
const nonNegativeIntSchema = z.number().int().nonnegative();

export const sessionBudgetSchema = z.object({
  totalTokens: nonNegativeIntSchema,
  promptTokens: nonNegativeIntSchema,
  completionTokens: nonNegativeIntSchema,
  cacheReadTokens: nonNegativeIntSchema,
  callCount: nonNegativeIntSchema,
  costs: z.record(z.string(), z.number().int()),
  lastContextTokens: nonNegativeIntSchema,
  lastCacheReadTokens: nonNegativeIntSchema,
});

const toolCallSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    arguments: z.string(),
    extra: jsonObjectSchema.optional(),
  })
  .passthrough();

const contentPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
  z
    .object({
      type: z.literal("image"),
      image: z
        .object({
          url: z.string(),
          detail: z.enum(["auto", "low", "high"]).optional(),
        })
        .passthrough(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("video"),
      video: z.object({ url: z.string() }).passthrough(),
    })
    .passthrough(),
]);

export const sessionMessageSchema: z.ZodType<Message> = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.union([z.string(), z.array(contentPartSchema)]).nullable(),
    reasoning_content: z.string().optional(),
    tool_calls: z.array(toolCallSchema).optional(),
    tool_call_id: z.string().optional(),
    name: z.string().optional(),
    extra: jsonObjectSchema.optional(),
  })
  .passthrough();

export const sessionMetaLineSchema = z
  .object({
    type: z.literal("session_meta"),
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    sessionId: z.string(),
    workspaceRoot: z.string(),
    createdAt: nonNegativeIntSchema,
    /**
     * Product/client that first created the session file, for example "evil-jelly-cli".
     * This is not a user, model provider, trace source, or per-resume field.
     */
    originator: z.string().min(1),
    appVersion: z.string().min(1),
  })
  .passthrough();

const eventBaseFields = {
  seq: z.number().int().positive(),
  timestamp: nonNegativeIntSchema,
};

export const runSegmentStartedEventSchema = z
  .object({
    ...eventBaseFields,
    type: z.literal("run_segment_started"),
    /**
     * "created" starts a brand-new session, including the session created by /clear.
     * "resumed" starts another process/run segment for an existing session. Whether the old
     * segment ended because of startup resume or /resume is not relevant to the new segment.
     */
    kind: z.enum(["created", "resumed"]),
    traceId: z.string(),
    provider: z.string().optional(),
    modelId: z.string(),
    cwd: z.string(),
    gitBranch: z.string().optional(),
    gitHead: z.string().optional(),
  })
  .passthrough();

export const runSegmentEndedEventSchema = z
  .object({
    ...eventBaseFields,
    type: z.literal("run_segment_ended"),
    /**
     * Deliberately repeated from run_segment_started as an integrity/correlation check. Event
     * ordering can infer it, but the duplicate makes a mismatched close directly detectable.
     */
    traceId: z.string(),
    /** Status of this run segment, not a permanent "session completed" state. */
    status: z.enum(["completed", "interrupted", "error"]),
    reason: z.enum(["exit", "switch_session", "new_session", "abort", "error"]),
    errorMessage: z.string().optional(),
  })
  .passthrough();

export const messageSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("user_input"),
      /**
       * initial starts a top-level turn; steer is additional user-authored context injected while
       * that same turn is still running.
       */
      inputKind: z.enum(["initial", "steer"]),
    })
    .passthrough(),
  z.object({ kind: z.literal("model") }).passthrough(),
  z.object({ kind: z.literal("tool") }).passthrough(),
  z.object({ kind: z.literal("agent_runtime") }).passthrough(),
  z.object({ kind: z.literal("recovery") }).passthrough(),
]);

export const messageRecordedEventSchema = z
  .object({
    ...eventBaseFields,
    type: z.literal("message_recorded"),
    /** One top-level user request and all model/tool activity it causes share a turnId. */
    turnId: z.string(),
    /**
     * Origin of the canonical Core Message. User input additionally distinguishes the initial
     * request that starts a turn from later steers injected into that same turn. Model is an
     * assistant message (including tool_calls); tool is a canonical role=tool result (including
     * view_image image content); agent_runtime and recovery are synthetic messages.
     *
     * Adapter-only wire-role conversion is not persisted. Compact replacement messages live only
     * inside context_compacted.replacementHistory, not as message_recorded events.
     */
    source: messageSourceSchema,
    message: sessionMessageSchema,
  })
  .passthrough();

export const turnCompletedEventSchema = z
  .object({
    ...eventBaseFields,
    type: z.literal("turn_completed"),
    turnId: z.string(),
    status: z.enum(["completed", "interrupted", "error"]),
    recovered: z.boolean().optional(),
  })
  .passthrough();

/**
 * An active-context reconstruction boundary, not a conversation turn or transcript replacement.
 * It never affects userTurns and may occur inside a running turn via parentTurnId.
 */
export const contextCompactedEventSchema = z
  .object({
    ...eventBaseFields,
    type: z.literal("context_compacted"),
    /** /compress is manual; context-window maintenance is auto. */
    trigger: z.enum(["auto", "manual"]),
    /**
     * Present when auto compaction happened while a user turn was still running.
     * The public parse boundaries reject parentTurnId on manual compaction.
     */
    parentTurnId: z.string().optional(),
    replacementHistory: z.array(sessionMessageSchema),
    beforeMessageCount: nonNegativeIntSchema,
    afterMessageCount: nonNegativeIntSchema,
    beforeTokens: nonNegativeIntSchema.optional(),
    afterTokens: nonNegativeIntSchema.optional(),
    keptUserMessages: nonNegativeIntSchema.optional(),
    durationMs: nonNegativeIntSchema.optional(),
  })
  .passthrough();

export const sessionStatusSchema = z.enum(["active", "idle", "interrupted", "error"]);

export const sessionStateEventSchema = z
  .object({
    ...eventBaseFields,
    type: z.literal("session_state"),
    coveredThroughSeq: nonNegativeIntSchema,
    userTurns: nonNegativeIntSchema,
    title: z.string(),
    lastCompactSeq: z.number().int().positive().optional(),
    lastCompactOffset: nonNegativeIntSchema.optional(),
    traceIds: z.array(z.string()),
    budget: sessionBudgetSchema.optional(),
    /**
     * active: segment remains open after a completed turn/compact checkpoint
     * idle: segment exited cleanly and the session can be resumed later
     * interrupted: user abort or recovered incomplete turn
     * error: segment ended on an unhandled error
     */
    status: sessionStatusSchema,
  })
  .passthrough();

export const budgetUpdatedEventSchema = z
  .object({
    ...eventBaseFields,
    type: z.literal("budget_updated"),
    /**
     * Latest cumulative session budget, persisted after each successful model usage update.
     * This limits budget loss in a killed mid-turn. session_state may repeat it as a checkpoint.
     */
    budget: sessionBudgetSchema,
  })
  .passthrough();

const legacyMetaSchema = z
  .object({
    id: z.string(),
    workspaceRoot: z.string(),
    title: z.string(),
    createdAt: nonNegativeIntSchema,
    updatedAt: nonNegativeIntSchema,
    turns: nonNegativeIntSchema,
    traceIds: z.array(z.string()),
    budget: sessionBudgetSchema.optional(),
  })
  .passthrough();

export const legacySnapshotImportedEventSchema = z
  .object({
    ...eventBaseFields,
    type: z.literal("legacy_snapshot"),
    sourceSchemaVersion: z.literal(1),
    importedAt: nonNegativeIntSchema,
    legacyMeta: legacyMetaSchema,
    messages: z.array(sessionMessageSchema),
  })
  .passthrough();

export const knownSessionEventSchema = z.discriminatedUnion("type", [
  runSegmentStartedEventSchema,
  runSegmentEndedEventSchema,
  messageRecordedEventSchema,
  turnCompletedEventSchema,
  contextCompactedEventSchema,
  sessionStateEventSchema,
  budgetUpdatedEventSchema,
  legacySnapshotImportedEventSchema,
]);

export const sessionEventEnvelopeSchema = z
  .object({
    ...eventBaseFields,
    type: z.string().min(1),
  })
  .passthrough();

export type SessionBudgetData = z.infer<typeof sessionBudgetSchema>;
export type SessionMetaLine = z.infer<typeof sessionMetaLineSchema>;
export type SessionEventBase = z.infer<typeof sessionEventEnvelopeSchema>;
export type MessageSource = z.infer<typeof messageSourceSchema>;
export type RunSegmentStartedEvent = z.infer<typeof runSegmentStartedEventSchema>;
export type RunSegmentEndedEvent = z.infer<typeof runSegmentEndedEventSchema>;
export type MessageRecordedEvent = z.infer<typeof messageRecordedEventSchema>;
export type TurnCompletedEvent = z.infer<typeof turnCompletedEventSchema>;
export type ContextCompactedEvent = z.infer<typeof contextCompactedEventSchema>;
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type SessionStateEvent = z.infer<typeof sessionStateEventSchema>;
export type BudgetUpdatedEvent = z.infer<typeof budgetUpdatedEventSchema>;
export type LegacySnapshotImportedEvent = z.infer<typeof legacySnapshotImportedEventSchema>;
export type KnownSessionEvent = z.infer<typeof knownSessionEventSchema>;
export type UnknownSessionEvent = z.infer<typeof sessionEventEnvelopeSchema>;
export type SessionEvent = KnownSessionEvent | UnknownSessionEvent;

const newSessionEventSchema = z.discriminatedUnion("type", [
  runSegmentStartedEventSchema.omit({ seq: true, timestamp: true }),
  runSegmentEndedEventSchema.omit({ seq: true, timestamp: true }),
  messageRecordedEventSchema.omit({ seq: true, timestamp: true }),
  turnCompletedEventSchema.omit({ seq: true, timestamp: true }),
  contextCompactedEventSchema.omit({ seq: true, timestamp: true }),
  sessionStateEventSchema.omit({ seq: true, timestamp: true }),
  budgetUpdatedEventSchema.omit({ seq: true, timestamp: true }),
  legacySnapshotImportedEventSchema.omit({ seq: true, timestamp: true }),
]);
export type NewSessionEvent = z.infer<typeof newSessionEventSchema>;

const knownEventTypes = new Set<string>(
  knownSessionEventSchema.options.map((schema) => schema.shape.type.value),
);

export class SessionSchemaError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SessionSchemaError";
  }
}

export function parseSessionMetaLine(value: unknown): SessionMetaLine {
  const parsed = sessionMetaLineSchema.safeParse(value);
  if (!parsed.success) {
    throw new SessionSchemaError("Invalid Session V2 metadata line", parsed.error);
  }
  return parsed.data;
}

export function parseSessionEvent(value: unknown): SessionEvent {
  const envelope = sessionEventEnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    throw new SessionSchemaError("Invalid Session V2 event envelope", envelope.error);
  }
  if (envelope.data.type === "session_meta") {
    throw new SessionSchemaError("session_meta may only appear as the first JSONL line");
  }
  if (!knownEventTypes.has(envelope.data.type)) {
    return envelope.data;
  }
  const parsed = knownSessionEventSchema.safeParse(value);
  if (!parsed.success) {
    throw new SessionSchemaError(`Invalid ${envelope.data.type} event`, parsed.error);
  }
  assertValidCompactionParent(parsed.data);
  return parsed.data;
}

export function parseNewSessionEvent(value: unknown): NewSessionEvent {
  const parsed = newSessionEventSchema.safeParse(value);
  if (!parsed.success) {
    throw new SessionSchemaError("Invalid new Session V2 event", parsed.error);
  }
  assertValidCompactionParent(parsed.data);
  return parsed.data;
}

/**
 * Zod 3 cannot place a refined object inside a discriminated union, so keep this cross-field
 * invariant at both public parse boundaries while the object schema remains the shape authority.
 */
function assertValidCompactionParent(event: KnownSessionEvent | NewSessionEvent): void {
  if (
    event.type === "context_compacted" &&
    event.trigger === "manual" &&
    event.parentTurnId !== undefined
  ) {
    throw new SessionSchemaError(
      "Invalid context_compacted event: parentTurnId is only valid for automatic compaction",
    );
  }
}

export function parseSessionStateEvent(value: unknown): SessionStateEvent {
  const parsed = sessionStateEventSchema.safeParse(value);
  if (!parsed.success) {
    throw new SessionSchemaError("Invalid session_state event", parsed.error);
  }
  return parsed.data;
}

export function isKnownSessionEvent(event: SessionEvent): event is KnownSessionEvent {
  return knownEventTypes.has(event.type);
}
