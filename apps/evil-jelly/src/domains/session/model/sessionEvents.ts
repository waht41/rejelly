import { z } from "zod";
import {
  messageSourceSchema,
  nonUserMessageSourceSchema,
} from "../../../shared/session/messageSource";
import { sessionMessageSchema } from "./sessionMessageSchema";
import {
  storedPromptAttachmentV1Schema,
  storedPromptDocumentV1Schema,
  storedPromptInputV1Schema,
} from "./storedPromptInput";
import {
  assertMatchingStoredUserInputMaterialization,
  storedUserInputMaterializationV1Schema,
} from "./storedUserInputMaterialization";

export { sessionMessageSchema } from "./sessionMessageSchema";

export const SESSION_SCHEMA_VERSION = 3 as const;
export const LEGACY_JSONL_SESSION_SCHEMA_VERSION = 2 as const;
export type SessionSchemaVersion =
  | typeof LEGACY_JSONL_SESSION_SCHEMA_VERSION
  | typeof SESSION_SCHEMA_VERSION;

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

const sessionMetaFields = {
  type: z.literal("session_meta"),
  sessionId: z.string(),
  workspaceRoot: z.string(),
  createdAt: nonNegativeIntSchema,
  /** Product/client that first created the session file. */
  originator: z.string().min(1),
  appVersion: z.string().min(1),
};

export const sessionMetaLineV2Schema = z
  .object({
    ...sessionMetaFields,
    schemaVersion: z.literal(LEGACY_JSONL_SESSION_SCHEMA_VERSION),
  })
  .passthrough();

export const sessionMetaLineV3Schema = z
  .object({
    ...sessionMetaFields,
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
  })
  .passthrough();

export const sessionMetaLineSchema = z.discriminatedUnion("schemaVersion", [
  sessionMetaLineV2Schema,
  sessionMetaLineV3Schema,
]);

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

const v3MessageRecordedEventSchema = z
  .object({
    ...eventBaseFields,
    type: z.literal("message_recorded"),
    turnId: z.string(),
    source: nonUserMessageSourceSchema,
    message: sessionMessageSchema,
  })
  .passthrough();

export const userInputRecordedEventSchema = z
  .object({
    ...eventBaseFields,
    type: z.literal("user_input_recorded"),
    turnId: z.string(),
    inputKind: z.enum(["initial", "steer"]),
    document: storedPromptDocumentV1Schema,
    attachments: z.array(storedPromptAttachmentV1Schema),
    materialized: storedUserInputMaterializationV1Schema,
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
 * It never affects userTurns and may occur while a turn is active via activeTurnId.
 */
export const contextCompactedEventSchema = z
  .object({
    ...eventBaseFields,
    type: z.literal("context_compacted"),
    /** /compress is manual; context-window maintenance is auto. */
    trigger: z.enum(["auto", "manual"]),
    /**
     * Present when auto compaction happened while a user turn was still running.
     * The public parse boundaries reject activeTurnId on manual compaction.
     */
    activeTurnId: z.string().optional(),
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

export const legacySessionMetaSchema = z
  .object({
    /** Durable session id, stable across resume segments and distinct from any trace id. */
    id: z.string().min(1),
    /** Absolute workspace root whose bucket owns the session. */
    workspaceRoot: z.string(),
    /** First real user line, truncated for picker display. */
    title: z.string(),
    /** Creation time retained from the original V1 record when a session is migrated. */
    createdAt: nonNegativeIntSchema,
    /** Last durable update time, used to sort the session picker. */
    updatedAt: nonNegativeIntSchema,
    /** Count of real initial user turns; steers and compaction bridges do not increment it. */
    turns: nonNegativeIntSchema,
    /** Run trace ids accumulated across launch/resume segments for devtool correlation. */
    traceIds: z.array(z.string()),
    /** Latest cumulative token/cost snapshot, restored by `/status` after resume. */
    budget: sessionBudgetSchema.optional(),
  })
  .passthrough();

export const legacySnapshotImportedEventSchema = z
  .object({
    ...eventBaseFields,
    type: z.literal("legacy_snapshot"),
    sourceSchemaVersion: z.literal(1),
    importedAt: nonNegativeIntSchema,
    legacyMeta: legacySessionMetaSchema,
    messages: z.array(sessionMessageSchema),
  })
  .passthrough();

export const knownSessionEventSchema = z.discriminatedUnion("type", [
  runSegmentStartedEventSchema,
  runSegmentEndedEventSchema,
  messageRecordedEventSchema,
  userInputRecordedEventSchema,
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
export type LegacySessionMeta = z.infer<typeof legacySessionMetaSchema>;
export type SessionMetaLine = z.infer<typeof sessionMetaLineSchema>;
export type SessionEventBase = z.infer<typeof sessionEventEnvelopeSchema>;
export type RunSegmentStartedEvent = z.infer<typeof runSegmentStartedEventSchema>;
export type RunSegmentEndedEvent = z.infer<typeof runSegmentEndedEventSchema>;
export type MessageRecordedEvent = z.infer<typeof messageRecordedEventSchema>;
export type UserInputRecordedEvent = z.infer<typeof userInputRecordedEventSchema>;
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
  v3MessageRecordedEventSchema.omit({ seq: true, timestamp: true }),
  userInputRecordedEventSchema.omit({ seq: true, timestamp: true }),
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
    throw new SessionSchemaError("Invalid Session metadata line", parsed.error);
  }
  return parsed.data;
}

export function parseSessionEvent(
  value: unknown,
  schemaVersion: SessionSchemaVersion = SESSION_SCHEMA_VERSION,
): SessionEvent {
  const envelope = sessionEventEnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    throw new SessionSchemaError("Invalid Session event envelope", envelope.error);
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
  if (
    schemaVersion === LEGACY_JSONL_SESSION_SCHEMA_VERSION &&
    parsed.data.type === "user_input_recorded"
  ) {
    throw new SessionSchemaError("Session V2 cannot contain user_input_recorded events");
  }
  if (
    schemaVersion === SESSION_SCHEMA_VERSION &&
    parsed.data.type === "message_recorded" &&
    parsed.data.source.kind === "user_input"
  ) {
    throw new SessionSchemaError("Session V3 user input must use user_input_recorded");
  }
  if (parsed.data.type === "user_input_recorded") {
    const input = storedPromptInputV1Schema.safeParse({
      document: parsed.data.document,
      attachments: parsed.data.attachments,
    });
    if (!input.success) {
      throw new SessionSchemaError(
        "Invalid stored PromptInput in user_input_recorded",
        input.error,
      );
    }
    try {
      assertMatchingStoredUserInputMaterialization(input.data, parsed.data.materialized);
    } catch (error) {
      throw new SessionSchemaError(
        "Stored materialization does not match user_input_recorded document",
        error,
      );
    }
  }
  assertValidCompactionTurnAssociation(parsed.data);
  return parsed.data;
}

export function parseNewSessionEvent(value: unknown): NewSessionEvent {
  const parsed = newSessionEventSchema.safeParse(value);
  if (!parsed.success) {
    throw new SessionSchemaError("Invalid new Session V3 event", parsed.error);
  }
  if (parsed.data.type === "user_input_recorded") {
    const input = storedPromptInputV1Schema.safeParse({
      document: parsed.data.document,
      attachments: parsed.data.attachments,
    });
    if (!input.success) {
      throw new SessionSchemaError(
        "Invalid stored PromptInput in user_input_recorded",
        input.error,
      );
    }
    try {
      assertMatchingStoredUserInputMaterialization(input.data, parsed.data.materialized);
    } catch (error) {
      throw new SessionSchemaError(
        "Stored materialization does not match user_input_recorded document",
        error,
      );
    }
  }
  assertValidCompactionTurnAssociation(parsed.data);
  return parsed.data;
}

/**
 * Zod 3 cannot place a refined object inside a discriminated union, so keep this cross-field
 * invariant at both public parse boundaries while the object schema remains the shape authority.
 */
function assertValidCompactionTurnAssociation(event: KnownSessionEvent | NewSessionEvent): void {
  if (
    event.type === "context_compacted" &&
    event.trigger === "manual" &&
    event.activeTurnId !== undefined
  ) {
    throw new SessionSchemaError(
      "Invalid context_compacted event: activeTurnId is only valid for automatic compaction",
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
