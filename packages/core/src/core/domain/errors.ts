/**
 * Unified Error Classes
 *
 * All framework-specific errors are defined here.
 */

import { ZodError } from "zod";
import { sanitizeForJson } from "../../utils/object";
import type { ToolCall } from "./model";

/**
 * Payload for AttemptsExhaustedError.
 * Uses "issues" instead of "errors" to align with Zod terminology.
 */
export interface AttemptsExhaustedPayload {
  /** Number of attempts made (maxRetries + 1) */
  attempts: number;
  /** All accumulated issue messages (aligned with Zod naming) */
  issues: string[];
  /** Last failure type: 'schema' | 'validator' | 'no_content' | 'parse_error' | 'llm_error' */
  lastFailureType: string | null;
  /** Last parsed data (if any) before failure */
  lastData: unknown;
  /** Last raw LLM response text */
  lastRawText: string;
}

/**
 * Attempts Exhausted Error
 *
 * Thrown when all validation/LLM attempts are exhausted.
 * Named "attempts" to avoid confusion with tool/network retries.
 *
 * Payload fields are flattened onto the instance for convenient access (e.g. DevTools).
 */
export class AttemptsExhaustedError extends Error {
  readonly name = "AttemptsExhaustedError";

  public readonly attempts: number;
  public readonly issues: string[];
  public readonly lastFailureType: string | null;
  public readonly lastData: unknown;
  public readonly lastRawText: string;

  constructor(payload: AttemptsExhaustedPayload) {
    const count = payload.issues.length;
    const suffix =
      count > 0 ? `${count} issue${count !== 1 ? "s" : ""} found.` : "No issues captured.";

    super(`All attempts exhausted (${payload.attempts} attempts). ${suffix}`);

    this.attempts = payload.attempts;
    this.issues = payload.issues;
    this.lastFailureType = payload.lastFailureType;
    this.lastData = payload.lastData;
    this.lastRawText = payload.lastRawText;
  }
}

/**
 * Turn Budget Exceeded Error
 *
 * Engine-level guard: thrown by `executeTurn` when the model turns consumed in the
 * current generation (including validation retries) reach `maxTurnSteps`. This is a
 * policy-agnostic backstop — for custom policies (e.g. graph/ToT) it acts as the
 * per-generation node budget, independent of any tool-call loop.
 *
 * Intentionally NOT related to ToolLoopExceededError by inheritance: that error is
 * the preset policy's own failure vocabulary, and its `actualTurns` measures a
 * different quantity (loop turn steps vs. model calls here). To handle "ran out of
 * turns" uniformly, check `isTurnBudgetExceededError(e) || isToolLoopExceededError(e)`.
 */
export class TurnBudgetExceededError extends Error {
  readonly name = "TurnBudgetExceededError";

  constructor(
    /** Configured max model turns per generation (maxTurnSteps) */
    public readonly maxTurnSteps: number,
    /** Model calls consumed before abort — counts every executeTurn, including validation retries */
    public readonly actualTurns: number = maxTurnSteps,
  ) {
    super(
      `Turn budget exceeded: ${actualTurns} model turn(s) consumed in this generation, max allowed is ${maxTurnSteps}. ` +
        `Note that validation retries also consume turns. ` +
        `Consider increasing maxTurnSteps in createAgent config if this is expected.`,
    );
  }
}

/**
 * Tool Loop Exceeded Error
 *
 * Policy-level outcome of the preset tool-call-loop policy (promptAgent / promptChat):
 * the model kept returning tool calls and never produced final content within
 * `maxTurnSteps` LLM turns (not individual tool invocations).
 *
 * Unlike TurnBudgetExceededError (the engine-level guard), `actualTurns` here counts
 * loop turn steps — validation retries within one step count as a single turn.
 */
export class ToolLoopExceededError extends Error {
  readonly name = "ToolLoopExceededError";

  constructor(
    /** Configured max LLM turns in the prompt loop */
    public readonly maxTurnSteps: number,
    /** Loop turn steps executed before abort (validation retries within a step count once) */
    public readonly actualTurns: number = maxTurnSteps,
  ) {
    super(
      `Prompt loop exceeded: ${actualTurns} model turn(s), max allowed is ${maxTurnSteps}. ` +
        `This may indicate an infinite loop or a task that requires more turns. ` +
        `Consider increasing maxTurnSteps in createAgent config if this is expected.`,
    );
  }
}

/**
 * Invalid Message History Error
 *
 * Thrown when an LLM message list violates chat history invariants before
 * being sent to a model.
 */
export class InvalidMessageHistoryError extends Error {
  readonly name = "InvalidMessageHistoryError";

  constructor(
    public readonly index: number,
    public readonly reason: string,
  ) {
    super(`Invalid message history at index ${index}: ${reason}`);
  }
}

/**
 * Payload for LoopMissingToolOutputError.
 */
export interface LoopMissingToolOutputPayload {
  /** Model-originated calls for this batch (same ids as the prompt turn's tool_calls) */
  readonly originalCalls: readonly ToolCall[];
  /**
   * Each `callId` that is short one or more `ToolOutput` entries vs. the batch
   * (duplicated when the same id appears multiple times in `originalCalls`).
   */
  readonly missingCallIds: readonly string[];
}

/**
 * Loop Missing Tool Output Error
 *
 * Thrown when `ToolCallLoopMiddleware` returns a `ToolOutput[]` that does not
 * cover every `ToolCall` in the current batch (e.g. filtered calls away without
 * merging forged/blocked outputs with `next(...)` results).
 */
export class LoopMissingToolOutputError extends Error {
  readonly name = "LoopMissingToolOutputError";

  public readonly originalCalls: readonly ToolCall[];
  public readonly missingCallIds: readonly string[];

  constructor(payload: LoopMissingToolOutputPayload) {
    const unique = [...new Set(payload.missingCallIds)];
    const suffix =
      unique.length <= 3
        ? unique.join(", ")
        : `${unique.slice(0, 3).join(", ")} (+${unique.length - 3} more)`;
    super(
      `ToolCallLoopMiddleware returned incomplete ToolOutput[]: missing result for tool_call_id(s): ${suffix}. ` +
        `Each ToolCall in the current batch must have exactly one ToolOutput with matching callId ` +
        `(merge blocked/forged outputs with results from next(...) before returning).`,
    );
    this.originalCalls = payload.originalCalls;
    this.missingCallIds = payload.missingCallIds;
  }
}

/**
 * Invalid Tool Output Error
 *
 * Thrown when a tool handler returns undefined or a non-JSON-serializable value.
 */
export class InvalidToolOutputError extends Error {
  readonly name = "InvalidToolOutputError";

  constructor(
    /** Tool name for debugging */
    public readonly toolName: string,
    /** Optional nested path where validation failed */
    public readonly path?: string,
    /** Serializable validation reason */
    public readonly reason?: string,
  ) {
    const pathInfo = path ? ` at "${path}"` : "";
    const reasonInfo = reason ? ` Reason: ${reason}.` : "";
    super(
      `Tool "${toolName}" returned an invalid output${pathInfo}.${reasonInfo} ` +
        "Tool handlers must return a JSON-serializable value (string, object, array, number, boolean, or null).",
    );
  }
}

/**
 * Payload for BudgetExceededError.
 */
export interface BudgetExceededPayload {
  /** Which budget dimension was exceeded */
  kind: "cost" | "tokens";
  /** Current accumulated value at the time of breach */
  current: number;
  /** Configured limit that was exceeded */
  limit: number;
  /** Billing unit key when kind === "cost" (e.g. micro_usd) */
  costUnit?: string;
}

/**
 * Budget Exceeded Error
 *
 * Thrown when cost or token budget is exceeded.
 * Structured fields let DevTools display precise budget data without parsing the message.
 */
export class BudgetExceededError extends Error {
  readonly name = "BudgetExceededError";

  public readonly kind: "cost" | "tokens";
  public readonly current: number;
  public readonly limit: number;
  /** Present only when kind === "cost" and a billing unit was specified (not emitted when absent). */
  declare readonly costUnit?: string;

  constructor(payload: BudgetExceededPayload) {
    const msg =
      payload.kind === "cost"
        ? payload.costUnit !== undefined
          ? `Cost limit exceeded: ${payload.costUnit} ${payload.current} > limit ${payload.limit}`
          : `Cost limit exceeded: $${payload.current.toFixed(4)} > limit $${payload.limit}`
        : `Token limit exceeded: ${payload.current} > limit ${payload.limit}`;
    super(msg);

    this.kind = payload.kind;
    this.current = payload.current;
    this.limit = payload.limit;
    if (payload.costUnit !== undefined) {
      Object.defineProperty(this, "costUnit", {
        value: payload.costUnit,
        enumerable: true,
        writable: false,
        configurable: true,
      });
    }
  }
}

/**
 * Why a single cost entry failed validation (budget ledger values must be finite integers).
 */
export type InvalidCostReason = "not_number" | "not_finite" | "not_integer";

export interface InvalidCostValuePayload {
  /** Billing unit key (e.g. micro_usd) */
  billingUnit: string;
  /** Call site label (e.g. Tool[name], Model[id]) */
  source: string;
  /** Which validation step failed */
  reason: InvalidCostReason;
  /** Raw value that failed (for debugging) */
  value: unknown;
}

/**
 * Invalid Cost Value Error
 *
 * Thrown when a cost entry is not a finite integer (e.g. float currency, NaN, or wrong type).
 */
export class InvalidCostValueError extends Error {
  readonly name = "InvalidCostValueError";

  public readonly billingUnit: string;
  public readonly source: string;
  public readonly reason: InvalidCostReason;
  public readonly value: unknown;

  constructor(payload: InvalidCostValuePayload) {
    const hint =
      payload.reason === "not_number"
        ? "Expected a number; use integers for billing amounts."
        : payload.reason === "not_finite"
          ? "Expected a finite number (not NaN or Infinity)."
          : "Expected an integer; use micro_* units (e.g. micro_usd) instead of float currency.";
    super(
      `[InvalidCostValue] ${payload.source} — unit '${payload.billingUnit}': ${hint} (value: ${String(payload.value)})`,
    );

    this.billingUnit = payload.billingUnit;
    this.source = payload.source;
    this.reason = payload.reason;
    this.value = payload.value;
  }
}

/**
 * Abort Error
 *
 * Thrown when an operation is aborted via AbortSignal.
 * Uses DOMException when available (Node 17+ / Browser), falls back to custom Error.
 */
export class AbortError extends Error {
  readonly name = "AbortError";
  readonly reason?: unknown;

  // biome-ignore lint/correctness/noUnreachableSuper: Intentional error wrapping logic
  constructor(reason?: unknown) {
    // Prefer standard DOMException if available (Node 17+ / Browser)
    if (typeof DOMException !== "undefined") {
      const message = reason != null ? `Operation aborted: ${String(reason)}` : "Operation aborted";
      const domError = new DOMException(message, "AbortError");

      // Attach reason property
      Object.defineProperty(domError, "reason", {
        value: reason,
        writable: false,
        enumerable: true,
      });

      // biome-ignore lint/correctness/noConstructorReturn: Intentional error wrapping logic
      return domError as unknown as AbortError;
    }

    // Fallback: custom Error
    const message = reason != null ? `Operation aborted: ${String(reason)}` : "Operation aborted";
    super(message);
    this.reason = reason;
  }

  /**
   * Create AbortError from AbortSignal
   */
  static fromSignal(signal?: AbortSignal): AbortError {
    return new AbortError(signal?.reason);
  }
}

/**
 * Context Not Found Error
 *
 * Thrown when trying to access agent context outside of agent handler.
 */
export class ContextNotFoundError extends Error {
  readonly name = "ContextNotFoundError";

  constructor() {
    super(
      "No agent context found. " +
        "Make sure you are calling this function within an agent handler " +
        "that was started with an agent handler.",
    );
  }
}

/**
 * Requires Agent Context Error
 *
 * Thrown when an API that requires an agent context is called at top level.
 * These APIs must run within an agent context (e.g. inside runWith or an agent handler), not as root.
 */
export class RequiresAgentContextError extends Error {
  readonly name = "RequiresAgentContextError";

  constructor(
    /** API name for clearer message (e.g. 'withCustomSpan') */
    public readonly apiName: string,
  ) {
    super(
      `${apiName} must be called within an agent context (e.g. inside runWith or an agent handler), not at top level.`,
    );
  }
}

/**
 * Model Registry Not Found Error
 *
 * Thrown when an agent has model set to a string id but that id is not present
 * in runWith's modelRegistry (shared.modelRegistry). Run the agent inside
 * runWith(..., { modelRegistry: { [id]: adapter } }) or use a ModelAdapter instance.
 */
export class ModelRegistryNotFoundError extends Error {
  readonly name = "ModelRegistryNotFoundError";

  constructor(
    /** Model id that was not found in registry */
    public readonly modelId: string,
    /** Agent id (for debugging) */
    public readonly agentId: string,
    /** Available ids in registry when registry exists but id is missing */
    public readonly registeredIds?: string[],
  ) {
    const hint =
      registeredIds && registeredIds.length > 0
        ? ` Available ids in modelRegistry: ${registeredIds.map((id) => `'${id}'`).join(", ")}.`
        : " Run this agent inside runWith(..., { modelRegistry: { [id]: yourAdapter } }), or use a ModelAdapter instance in createAgent.";
    super(`[Rejelly] Model registry: no adapter for id '${modelId}' (agent: ${agentId}).${hint}`);
  }
}

/**
 * Scope Error
 *
 * Thrown by expectScope when required scope is missing or invalid.
 * Fail-fast: thrown immediately without consuming tokens.
 */
export class ExpectScopeError extends Error {
  readonly name = "ScopeError";
  public readonly issues?: Array<{ path: string; message: string }>;
  override readonly cause?: unknown;

  constructor(originalError: unknown, scopeName?: string) {
    let message = "Scope validation failed";
    let issues: Array<{ path: string; message: string }> | undefined;

    if (originalError instanceof ZodError) {
      const issueTexts = originalError.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
      message = `Scope Validation Failed${scopeName ? ` in <${scopeName}>` : ""}:\n  - ${issueTexts.join("\n  - ")}`;

      issues = originalError.errors.map((e) => ({
        path: e.path.join("."),
        message: e.message,
      }));
    } else if (originalError instanceof Error) {
      message = originalError.message;
    } else if (typeof originalError === "string") {
      message = originalError;
    }

    super(message);
    this.issues = issues;
    this.cause = originalError;

    Object.setPrototypeOf(this, ExpectScopeError.prototype);
  }
}

/**
 * Prompt Agent Already Called Error
 *
 * Thrown when promptAgent is called more than once in the same run.
 * promptAgent may only be called once per run.
 */
export class PromptAgentAlreadyCalledError extends Error {
  readonly name = "PromptAgentAlreadyCalledError";

  constructor() {
    super("promptAgent has already been called in this run; it may only be called once per run.");
  }
}

/**
 * After Prompt Agent Error
 *
 * Thrown when an API that must run before promptAgent() in the same generation
 * is called after promptAgent() has already run (draft.prompted is true).
 */
export class AfterPromptAgentError extends Error {
  readonly name = "AfterPromptAgentError";

  constructor(
    /** API name for clearer messages (e.g. 'equipSystem', 'onStream') */
    public readonly apiName: string,
  ) {
    super(
      `${apiName} must be called before promptAgent() in the same generation; it was called after promptAgent().`,
    );
  }
}

/**
 * Why the runtime handed to an execution primitive was rejected:
 * - `missing`: no `runtime` was passed (only reachable from untyped JS callers).
 * - `unsealed`: the object was hand-built instead of derived from a policy's
 *   `PromptContext` (via `fork()` or spread).
 * - `expired`: the owning policy already returned or threw; runtimes do not
 *   outlive their policy execution.
 * - `foreign`: the runtime belongs to another agent generation (e.g. smuggled
 *   into a child agent's handler).
 */
export type InvalidPromptRuntimeReason = "missing" | "unsealed" | "expired" | "foreign";

const INVALID_PROMPT_RUNTIME_DETAIL: Record<InvalidPromptRuntimeReason, string> = {
  missing: "no runtime was provided.",
  unsealed: "the runtime was not derived from a policy PromptContext.",
  expired: "the owning policy execution has already finished.",
  foreign: "the runtime belongs to a different agent generation.",
};

/**
 * Invalid Prompt Runtime Error
 *
 * Execution primitives (`executeTurn` / `executeTools`) are policy-internal:
 * they only accept a live runtime derived from the `PromptContext` handed to
 * the active policy handler by `createAgentPolicy`. This error gates every
 * other path. Needing a model call outside the presets is not itself an error —
 * the supported escape hatch is a small custom policy, which keeps telemetry,
 * validation, and lifecycle intact.
 */
export class InvalidPromptRuntimeError extends Error {
  readonly name = "InvalidPromptRuntimeError";

  constructor(
    /** Primitive that rejected the runtime (e.g. 'executeTurn') */
    public readonly apiName: string,
    public readonly reason: InvalidPromptRuntimeReason,
  ) {
    super(
      `${apiName} requires a live runtime forked from the active policy's PromptContext, but ${INVALID_PROMPT_RUNTIME_DETAIL[reason]} ` +
        `Execution primitives are policy-internal: obtain a PromptContext via createAgentPolicy and derive per-turn runtimes with ctx.fork(...). ` +
        `For model calls outside the preset policies, write a small custom policy instead of calling primitives from the agent handler.`,
    );
  }
}

/**
 * Duplicate Tool Name Error
 *
 * Thrown when two tools with the same name reach the same tool set. Tool names
 * must be unique: the executor resolves calls by name, and providers receive one
 * schema per name. Detected at registration (`equipTool`) for the generation
 * draft, and at the engine boundary (`executeTurn` / `executeTools`) for
 * runtime-provided tool sets that bypass equipTool (e.g. a policy's
 * `PromptContext.fork({ tools })`).
 */
export class DuplicateToolNameError extends Error {
  readonly name = "DuplicateToolNameError";

  constructor(
    /** The conflicting tool name */
    public readonly toolName: string,
    /** Entry point where the duplicate was detected (e.g. 'equipTool', 'executeTurn') */
    public readonly site: string = "equipTool",
  ) {
    super(`Duplicate tool name "${toolName}" (detected in ${site}); tool names must be unique.`);
  }
}

/**
 * Schema Conversion Error
 *
 * Thrown when Zod schema cannot be converted to JSON Schema (e.g. for LLM constraint).
 */
export class SchemaConversionError extends Error {
  readonly name = "SchemaConversionError";
  readonly cause?: unknown;

  constructor(message: string = "Failed to convert Zod schema to JSON Schema.", cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

/**
 * Model Not Found Error
 *
 * Thrown when no model adapter is found in context chain.
 */
export class ModelNotFoundError extends Error {
  readonly name = "ModelNotFoundError";

  constructor(
    /** Optional model ID that was requested */
    public readonly modelId?: string,
  ) {
    const msg = modelId
      ? `Model "${modelId}" not found. Please provide a valid model adapter.`
      : "No model adapter found. " +
        "Please provide a model adapter when creating the agent: createAgent({ model: yourAdapter, ... }), " +
        "or ensure a parent agent has already set a model.";
    super(msg);
  }
}

/**
 * Max Depth Exceeded Error
 *
 * Thrown when agent call depth exceeds maximum (prevents infinite recursion).
 */
export class MaxDepthExceededError extends Error {
  readonly name = "MaxDepthExceededError";

  constructor(
    /** Maximum allowed depth */
    public readonly maxDepth: number,
  ) {
    super(
      `Stack Overflow: Max agent depth (${maxDepth}) exceeded. ` +
        `Check for infinite recursion in your agent calls.`,
    );
  }
}

/**
 * Reborn Limit Exceeded Error
 *
 * Agent-level liveness guard: thrown by the reborn loop when the handler requests
 * more reborns than `maxReborns` (default 100). Counts reborn *events* (not
 * generations): `maxReborns` reborns means `maxReborns + 1` generations, since the
 * initial generation is not a reborn.
 *
 * Distinct from the per-generation turn guards (TurnBudgetExceededError /
 * ToolLoopExceededError, which bound depth *within* one generation) and from
 * budgetGuard (which bounds cost/tokens and is blind to zero-cost reborn loops):
 * this guards the *number of generations*. The usual root cause is a retry counter
 * kept in a handler local variable, which resets to its initial value on every
 * reborn and never reaches its limit — track such counters via equipMemory instead.
 */
export class RebornLimitExceededError extends Error {
  readonly name = "RebornLimitExceededError";

  constructor(
    /** Configured max reborn events (maxReborns) */
    public readonly maxReborns: number,
    /** The reborn number the handler attempted (the one over the limit) */
    public readonly attemptedReborns: number = maxReborns + 1,
  ) {
    super(
      `Reborn limit exceeded: handler requested reborn #${attemptedReborns}, max allowed is ${maxReborns} ` +
        `(${maxReborns} reborns => ${maxReborns + 1} generations). ` +
        `This usually means a retry/counter loop never converges: counters reset on reborn, ` +
        `so keep them in equipMemory (set before "return reborn()"), not handler local variables. ` +
        `Increase maxReborns in createAgent config if deep reborn chains are expected.`,
    );
  }
}

/**
 * Not Supported Error
 *
 * Thrown when a required runtime capability is missing (e.g. AsyncLocalStorage for context store).
 */
export class NotSupportedError extends Error {
  readonly name = "NotSupportedError";
}

/**
 * Subclasses set `readonly name = "…"`. Name-based checks stay correct when multiple @rejelly/core
 * copies are loaded (Vitest, nested node_modules) where `instanceof` would be a false negative.
 */
function isCoreErrorNamed(error: unknown, expectedName: string): boolean {
  if (error === null || typeof error !== "object" || !("name" in error)) {
    return false;
  }
  const n = (error as Record<string, unknown>).name;
  return typeof n === "string" && n === expectedName;
}

/**
 * Type guard: check if error is an AbortError
 *
 * Checks multiple patterns for compatibility across environments:
 * - error.name === 'AbortError' (standard DOMException)
 * - error.message === 'Aborted' (some fetch implementations)
 * - error.code === 'ABORT_ERR' (some Node.js versions)
 * - error.code === 20 (browser DOMException legacy code)
 */
export function isAbortError(error: unknown): error is AbortError {
  const seen = new Set<unknown>();

  const check = (value: unknown): boolean => {
    if (value === null || typeof value !== "object") {
      return false;
    }
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);

    const rec = value as Record<string, unknown>;

    // DOMException and Node AbortError
    if (rec.name === "AbortError") {
      return true;
    }

    // Exact match for specific known messages (some older or environment-specific fetch implementations)
    if (rec.message === "Aborted" || rec.message === "The user aborted a request.") {
      return true;
    }

    // Exact match for error codes
    const code = rec.code;
    if (code === "ABORT_ERR" || code === 20) {
      return true;
    }

    // Recursively check the underlying cause
    if (rec.cause !== undefined && rec.cause !== value) {
      return check(rec.cause);
    }

    return false;
  };

  return check(error);
}
/**
 * Type guard: check if error is a BudgetExceededError
 */
export function isBudgetExceededError(error: unknown): error is BudgetExceededError {
  return isCoreErrorNamed(error, "BudgetExceededError");
}

/**
 * Type guard: check if error is an InvalidCostValueError
 */
export function isInvalidCostValueError(error: unknown): error is InvalidCostValueError {
  return isCoreErrorNamed(error, "InvalidCostValueError");
}

/**
 * Type guard: check if error is an AttemptsExhaustedError
 */
export function isAttemptsExhaustedError(error: unknown): error is AttemptsExhaustedError {
  return isCoreErrorNamed(error, "AttemptsExhaustedError");
}

/**
 * Type guard: check if error is a TurnBudgetExceededError (engine-level guard only;
 * combine with isToolLoopExceededError to handle all "ran out of turns" cases)
 */
export function isTurnBudgetExceededError(error: unknown): error is TurnBudgetExceededError {
  return isCoreErrorNamed(error, "TurnBudgetExceededError");
}

/**
 * Type guard: check if error is a ToolLoopExceededError
 */
export function isToolLoopExceededError(error: unknown): error is ToolLoopExceededError {
  return isCoreErrorNamed(error, "ToolLoopExceededError");
}

/**
 * Type guard: check if error is an InvalidMessageHistoryError
 */
export function isInvalidMessageHistoryError(error: unknown): error is InvalidMessageHistoryError {
  return isCoreErrorNamed(error, "InvalidMessageHistoryError");
}

/**
 * Type guard: check if error is a LoopMissingToolOutputError
 */
export function isLoopMissingToolOutputError(error: unknown): error is LoopMissingToolOutputError {
  return isCoreErrorNamed(error, "LoopMissingToolOutputError");
}

/**
 * Type guard: check if error is an InvalidToolOutputError
 */
export function isInvalidToolOutputError(error: unknown): error is InvalidToolOutputError {
  return isCoreErrorNamed(error, "InvalidToolOutputError");
}

/**
 * Type guard: check if error is a ContextNotFoundError
 */
export function isContextNotFoundError(error: unknown): error is ContextNotFoundError {
  return isCoreErrorNamed(error, "ContextNotFoundError");
}

/**
 * Type guard: check if error is a RequiresAgentContextError
 */
export function isRequiresAgentContextError(error: unknown): error is RequiresAgentContextError {
  return isCoreErrorNamed(error, "RequiresAgentContextError");
}

/**
 * Type guard: check if error is a PromptAgentAlreadyCalledError
 */
export function isPromptAgentAlreadyCalledError(
  error: unknown,
): error is PromptAgentAlreadyCalledError {
  return isCoreErrorNamed(error, "PromptAgentAlreadyCalledError");
}

/**
 * Type guard: check if error is an AfterPromptAgentError
 */
export function isAfterPromptAgentError(error: unknown): error is AfterPromptAgentError {
  return isCoreErrorNamed(error, "AfterPromptAgentError");
}

/**
 * Type guard: check if error is an InvalidPromptRuntimeError
 */
export function isInvalidPromptRuntimeError(error: unknown): error is InvalidPromptRuntimeError {
  return isCoreErrorNamed(error, "InvalidPromptRuntimeError");
}

/**
 * Type guard: check if error is a DuplicateToolNameError
 */
export function isDuplicateToolNameError(error: unknown): error is DuplicateToolNameError {
  return isCoreErrorNamed(error, "DuplicateToolNameError");
}

/**
 * Type guard: check if error is a SchemaConversionError
 */
export function isSchemaConversionError(error: unknown): error is SchemaConversionError {
  return isCoreErrorNamed(error, "SchemaConversionError");
}

/**
 * Type guard: check if error is a ModelNotFoundError
 */
export function isModelNotFoundError(error: unknown): error is ModelNotFoundError {
  return isCoreErrorNamed(error, "ModelNotFoundError");
}

/**
 * Type guard: check if error is a MaxDepthExceededError
 */
export function isMaxDepthExceededError(error: unknown): error is MaxDepthExceededError {
  return isCoreErrorNamed(error, "MaxDepthExceededError");
}

/**
 * Type guard: check if error is a RebornLimitExceededError
 */
export function isRebornLimitExceededError(error: unknown): error is RebornLimitExceededError {
  return isCoreErrorNamed(error, "RebornLimitExceededError");
}

/**
 * Type guard: check if error is a NotSupportedError
 */
export function isNotSupportedError(error: unknown): error is NotSupportedError {
  return isCoreErrorNamed(error, "NotSupportedError");
}

/**
 * Restore Error
 *
 * Thrown by restoreSnapshot when restore fails (e.g. empty trace, span not found).
 */
export class RestoreError extends Error {
  readonly name = "RestoreError";
}

/**
 * Snapshot Disabled Error
 *
 * Thrown when snapshot is not allowed:
 * - dumpSnapshot when enableSnapshot is false on the current context
 * - runWith in production when snapshot is injected but enableSnapshot was not explicitly set to true
 *   (explicit enableSnapshot: true in production is an escape hatch: only logger.warn, no throw)
 * - createAgentContext in production with enableSnapshot: true does not throw; only logger.warn (escape hatch)
 */
export class SnapshotDisabledError extends Error {
  readonly name = "SnapshotDisabledError";
  /** Source of the error: 'dump' | 'runWith_snapshot' | 'runWith_enableSnapshot' | 'createAgentContext' */
  readonly source?: string;

  constructor(message: string, source?: string) {
    super(message);
    this.source = source;
  }
}

/**
 * Resource Not Found Error
 *
 * Thrown by expectResource when required resource is not found in context chain.
 * Fail-fast: thrown immediately without consuming tokens.
 */
export class ResourceNotFoundError extends Error {
  readonly name = "ResourceNotFoundError";
  public readonly key: string;

  constructor(
    /** Resource key that was not found */
    key: string,
    /** Error message */
    message: string,
  ) {
    super(message);
    this.key = key;
    // Restore prototype chain
    Object.setPrototypeOf(this, ResourceNotFoundError.prototype);
  }
}

/**
 * Type guard: check if error is a ScopeError
 */
export function isScopeError(error: unknown): error is ExpectScopeError {
  return isCoreErrorNamed(error, "ScopeError");
}

/**
 * Type guard: check if error is a RestoreError
 */
export function isRestoreError(error: unknown): error is RestoreError {
  return isCoreErrorNamed(error, "RestoreError");
}

/**
 * Type guard: check if error is a SnapshotDisabledError
 */
export function isSnapshotDisabledError(error: unknown): error is SnapshotDisabledError {
  return isCoreErrorNamed(error, "SnapshotDisabledError");
}

/**
 * Type guard: check if error is a ResourceNotFoundError
 */
export function isResourceNotFoundError(error: unknown): error is ResourceNotFoundError {
  return isCoreErrorNamed(error, "ResourceNotFoundError");
}

/**
 * Unified error classification code for model call failures.
 */
export type ModelErrorCode =
  | "rate_limit" // Rate limit hit (429) -> typically retryable with exponential backoff
  | "context_length" // Context window exceeded (400) -> not retryable, need to truncate memory
  | "auth_error" // Invalid API key (401/403) -> not retryable
  | "server_error" // Provider server failure (500/502/503) -> retryable
  | "unknown"; // Other unclassified errors

/**
 * Payload for ModelCallError constructor.
 */
export interface ModelCallPayload {
  /** Model identifier */
  modelId: string;
  /** Provider name */
  provider?: string;
  /**
   * Request endpoint (base URL) the adapter actually hit. Crucial for
   * diagnosing misconfigured gateways: provider errors like "invalid model"
   * come from whatever server the URL resolves to, and without the endpoint
   * in the message a wrong base URL is invisible.
   */
  endpoint?: string;
  /** Unified error classification code */
  code?: ModelErrorCode;
  /** Original error thrown by the underlying SDK */
  originalError?: unknown;
}

/**
 * Model Call Error
 *
 * Thrown when the underlying model adapter fails to communicate with the LLM API.
 * Wraps provider-specific errors into a unified framework error.
 */
export class ModelCallError extends Error {
  readonly name = "ModelCallError";

  public readonly modelId: string;
  public readonly provider?: string;
  public readonly endpoint?: string;
  public readonly code: ModelErrorCode;
  override readonly cause?: unknown;

  constructor(message: string, payload: ModelCallPayload) {
    super(
      payload.endpoint !== undefined
        ? `${message} (model: ${payload.modelId}, endpoint: ${payload.endpoint})`
        : message,
    );

    this.modelId = payload.modelId;
    this.provider = payload.provider;
    this.endpoint = payload.endpoint;
    this.code = payload.code ?? "unknown";
    this.cause = payload.originalError;

    Object.setPrototypeOf(this, ModelCallError.prototype);
  }
}

/**
 * Type guard: check if error is a ModelCallError
 */
export function isModelCallError(error: unknown): error is ModelCallError {
  return isCoreErrorNamed(error, "ModelCallError");
}

/**
 * Serializable error info
 *
 * Used in End events for consistent error reporting.
 * Can be created from Error object or constructed directly.
 */
export interface ErrorInfo {
  /** Error name/type (e.g., 'TypeError') */
  name: string;
  /** Error message */
  message: string;
  /** Stack trace (optional) */
  stack?: string;
  /** Recursively serialized cause chain (ES2022 Error.cause) */
  cause?: ErrorInfo;
  /** Structured extra properties from custom error classes (for DevTools) */
  details?: Record<string, unknown>;
}

/**
 * Create ErrorInfo from any thrown object safely.
 *
 * Custom enumerable properties (e.g. `issues`, `lastData`, `kind`, `limit`)
 * are collected into the `details` bag so DevTools can consume structured data.
 */
export function toErrorInfo(error: any, seen = new WeakSet()): ErrorInfo {
  const ERROR_BUILTIN_KEYS = new Set(["name", "message", "stack", "cause"]);

  if (typeof error !== "object" || error === null) {
    return {
      name: "Error",
      message: String(error),
    };
  }

  // Circular reference guard: break infinite cause chains
  if (seen.has(error)) {
    return {
      name: "CircularReference",
      message: "[Circular Reference Detected]",
    };
  }
  seen.add(error);

  const name = error.name !== undefined ? String(error.name) : "Error";
  const message = error.message !== undefined ? String(error.message) : "Unknown error";

  const details: Record<string, unknown> = {};
  for (const key of Object.keys(error)) {
    if (!ERROR_BUILTIN_KEYS.has(key)) {
      details[key] = sanitizeForJson(error[key]);
    }
  }

  const info: ErrorInfo = {
    name,
    message,
    ...(error.stack !== undefined ? { stack: String(error.stack) } : {}),
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };

  if (error.cause !== undefined) {
    info.cause = toErrorInfo(error.cause, seen);
  }

  return info;
}
