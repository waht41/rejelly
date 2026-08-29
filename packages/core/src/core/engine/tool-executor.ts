/**
 * Tool Executor
 *
 * Handles tool call execution and result formatting.
 * Architecture: runSingleTool (throwing core) -> executeSingleToolCore (errors-as-
 * tool-output) -> executeTools (loop) / callTool (manual single-tool) public APIs
 */

import { startTimer } from "../../utils/clock";
import { hashValue } from "../../utils/hash";
import { assertSerializable, safeClone, validateSerializable } from "../../utils/object";
import type { JsonObject, JsonValue } from "../../utils/type";
import { getCurrentContext, getCurrentContextSafe } from "../context/accessor";
import type {
  ToolCallLoopContext,
  ToolCallLoopMiddleware,
  ToolOutput,
  ToolTurn,
  ToolTurnEntry,
} from "../context/tool-call-loop";
import type { AgentContext } from "../context/type";
import { InvalidToolOutputError, LoopMissingToolOutputError, toErrorInfo } from "../domain/errors";
import type { MiddlewareInfo } from "../domain/event-payload";
import type { ToolExecutionResult } from "../domain/events";
import type { Message, MessageContent, ToolCall } from "../domain/model";
import {
  assertUniqueToolNames,
  isToolContent,
  type ToolContext,
  type ToolDefinition,
  type ToolMiddleware,
} from "../domain/tool";
import type { Emitter } from "../observability/telemetry";
import { withSpan } from "../observability/trace";
import { logger } from "../shared/logger/instance";
import { generateCallId } from "../snapshot/id";
import { getJournalEntry, recordJournal } from "../snapshot/journal";
import { flattenInstructions } from "./message-builder";
import { assertRuntimeUsable, type PromptRuntime } from "./runtime";

/** Built-in cache middleware name; omitted from tool execute event middleware list */
const CACHE_MIDDLEWARE_NAME = "cache";

// ============ Helper Functions ============

function calculateToolContentHash(toolName: string, input: JsonValue): string {
  return hashValue({ name: toolName, input });
}

/** Get middleware list for event (name + config), excluding built-in cache */
function getToolMiddlewaresForEvent(tool: ToolDefinition): MiddlewareInfo[] {
  return (tool.middlewares || [])
    .filter((mw) => mw.name !== CACHE_MIDDLEWARE_NAME)
    .map((mw) => ({ name: mw.name, config: mw.config }));
}

function emitToolsExecuteStart(
  emitter: Emitter | null,
  meta: { toolNames: string[]; toolMiddlewares?: MiddlewareInfo[] },
): void {
  emitter?.toolsExecuteStart({
    toolCallsCount: meta.toolNames.length,
    toolNames: meta.toolNames,
    toolMiddlewares: meta.toolMiddlewares,
  });
}

function emitToolsExecuteEnd(
  emitter: Emitter | null,
  meta: { toolNames: string[]; toolMiddlewares?: MiddlewareInfo[] },
  payload: { duration: number; toolResults: ToolExecutionResult[]; error?: Error },
): void {
  let successCount = 0;
  let failureCount = 0;
  for (const result of payload.toolResults) {
    if (result.success) successCount++;
    else failureCount++;
  }

  if (payload.error && payload.toolResults.length === 0) {
    failureCount = meta.toolNames.length;
  }

  const success = failureCount === 0 && !payload.error;
  emitter?.toolsExecuteEnd({
    toolCallsCount: meta.toolNames.length,
    toolNames: meta.toolNames,
    toolMiddlewares: meta.toolMiddlewares,
    successCount,
    failureCount,
    duration: payload.duration,
    toolResults: payload.toolResults,
    success,
    error: payload.error
      ? toErrorInfo(payload.error)
      : success
        ? undefined
        : toErrorInfo(new Error(`${failureCount} tool(s) failed`)),
  });
}

async function withToolExecutionEvents<T>(
  span: string,
  meta: { toolNames: string[]; toolMiddlewares?: MiddlewareInfo[] },
  run: () => Promise<{ results: ToolExecutionResult[]; value: T }>,
): Promise<T> {
  return withSpan(span, async (emitter) => {
    const elapsed = startTimer();
    emitToolsExecuteStart(emitter, meta);

    try {
      const { results, value } = await run();
      emitToolsExecuteEnd(emitter, meta, {
        duration: elapsed(),
        toolResults: results,
      });
      return value;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      emitToolsExecuteEnd(emitter, meta, {
        duration: elapsed(),
        toolResults: [],
        error: err,
      });
      throw error;
    }
  });
}

function safeJsonParse(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

function buildToolTurns(messages: Message[]): ToolTurn[] {
  const turns: ToolTurn[] = [];
  let pendingCalls: ToolCall[] | null = null;
  let roundEntries: ToolTurnEntry[] = [];

  const flushRound = () => {
    if (pendingCalls !== null && roundEntries.length > 0) {
      turns.push({ entries: safeClone(roundEntries) });
    }
    roundEntries = [];
  };

  for (const message of messages) {
    if (
      message.role === "assistant" &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length > 0
    ) {
      flushRound();
      pendingCalls = safeClone(message.tool_calls);
      continue;
    }

    if (
      message.role === "tool" &&
      pendingCalls !== null &&
      typeof message.tool_call_id === "string"
    ) {
      const call = pendingCalls.find((c) => c.id === message.tool_call_id);
      if (call) {
        roundEntries.push({
          callId: call.id,
          toolName: call.name,
          arguments: call.arguments,
        });
      }
      continue;
    }

    // Break tool-round collection on any unexpected message (e.g. plain assistant/user)
    if (pendingCalls !== null) {
      flushRound();
      pendingCalls = null;
    }
  }

  flushRound();

  return turns;
}

function toolOutputsToMessages(outputs: ToolOutput[]): Message[] {
  return outputs.map((output) => ({
    role: "tool",
    tool_call_id: output.callId,
    content: output.content,
  }));
}

function systemMessagesToText(messages: readonly Message[]): string | null {
  const parts = messages
    .map((message) => message.content)
    .filter((content): content is string => typeof content === "string");
  return parts.length > 0 ? parts.join("\n\n") : null;
}

function instructionMessagesToContent(messages: readonly Message[]): MessageContent | null {
  const contents = messages
    .map((message) => message.content)
    .filter((content): content is MessageContent => content !== null);
  return contents.length > 0 ? flattenInstructions(contents) : null;
}

export interface ExecuteToolsOptions {
  /**
   * Forked runtime paired with the executeTurn that produced these tool calls —
   * required, and subject to the same policy-internal gate as `executeTurn`
   * (`InvalidPromptRuntimeError` otherwise). Tools / loop middleware / loop
   * history (`runtime.messages`) and the loop-context system+instruction are all
   * taken from it. Pass the SAME runtime you gave `executeTurn` so the offered
   * tool set equals the executed one.
   */
  runtime: PromptRuntime;
  skipLoopMiddleware?: boolean;
}

/**
 * Keeps only ToolOutput rows that match the current model `tool_calls` batch (per-callId quota).
 * Drops surplus rows or rows whose callId never appeared in the batch; logs a warning for each drop.
 */
function filterToolOutputsToMatchBatch(
  toolCalls: readonly ToolCall[],
  outputs: ToolOutput[],
): ToolOutput[] {
  const slotsRemainingByCallId = new Map<string, number>();
  for (const toolCall of toolCalls) {
    const previous = slotsRemainingByCallId.get(toolCall.id) ?? 0;
    slotsRemainingByCallId.set(toolCall.id, previous + 1);
  }

  const keptOutputs: ToolOutput[] = [];
  for (const toolOutput of outputs) {
    const remaining = slotsRemainingByCallId.get(toolOutput.callId);
    if (remaining === undefined || remaining === 0) {
      const reason =
        remaining === undefined
          ? "unknown tool_call_id (not in this batch)"
          : "surplus ToolOutput for this tool_call_id";
      logger.warn(
        `Dropping ToolOutput from tool-call loop: ${reason} (tool_call_id=${toolOutput.callId}).`,
      );
      continue;
    }
    keptOutputs.push(toolOutput);
    slotsRemainingByCallId.set(toolOutput.callId, remaining - 1);
  }

  return keptOutputs;
}

function buildToolCallLoopContext(
  runtime: ExecuteToolsOptions["runtime"],
  step: number,
  messages: Message[],
  toolCalls: ToolCall[],
): ToolCallLoopContext {
  return {
    step,
    // Read-only reference (uncloned): messages can be large and this runs every tool round; the
    // `ToolCallLoopContext` contract already forbids mutation.
    messages,
    toolTurns: safeClone(buildToolTurns(messages)),
    systemInstruction: systemMessagesToText(runtime.system),
    instruction: instructionMessagesToContent(runtime.instruction),
    originalCalls: safeClone(toolCalls),
  };
}

function executeWithToolCallLoopMiddleware(
  middlewares: ToolCallLoopMiddleware[],
  loopCtx: ToolCallLoopContext,
  coreExecute: (calls: ToolCall[]) => Promise<ToolOutput[]>,
): Promise<ToolOutput[]> {
  const chain = composeMiddleware<ToolCall[], ToolOutput[]>(
    middlewares.map(
      (middleware) => async (calls, next) => middleware.handler(loopCtx, calls, next),
    ),
    coreExecute,
  );
  return chain([...loopCtx.originalCalls]);
}

/**
 * Ensures every ToolCall in the model batch has a matching ToolOutput (by callId, multiset-safe).
 * Run after ToolCallLoopMiddleware chain — filters must merge forged outputs with next(...) results.
 */
function assertToolOutputsCoverOriginalCalls(
  originalCalls: readonly ToolCall[],
  outputs: ToolOutput[],
): void {
  // How many ToolOutput entries each tool_call_id needs (model may repeat the same id).
  const expectedCountByCallId = new Map<string, number>();
  for (const toolCall of originalCalls) {
    const previous = expectedCountByCallId.get(toolCall.id) ?? 0;
    expectedCountByCallId.set(toolCall.id, previous + 1);
  }

  // How many ToolOutput entries we actually have per callId after middleware + executeToolOutputs.
  const actualCountByCallId = new Map<string, number>();
  for (const toolOutput of outputs) {
    const previous = actualCountByCallId.get(toolOutput.callId) ?? 0;
    actualCountByCallId.set(toolOutput.callId, previous + 1);
  }

  const missingCallIds: string[] = [];
  for (const [callId, expectedCount] of expectedCountByCallId) {
    const actualCount = actualCountByCallId.get(callId) ?? 0;
    // One missingCallIds entry per shortfall so LoopMissingToolOutputError can report multiset gaps.
    const shortfall = expectedCount - actualCount;
    for (let slotIndex = 0; slotIndex < shortfall; slotIndex++) {
      missingCallIds.push(callId);
    }
  }

  if (missingCallIds.length > 0) {
    throw new LoopMissingToolOutputError({ originalCalls, missingCallIds });
  }
}

function assertValidToolOutput(toolName: string, output: unknown): void {
  const result = validateSerializable(output, "", new WeakSet());
  if (!result.valid) {
    throw new InvalidToolOutputError(toolName, result.path, result.reason);
  }
}

interface SerializedToolResult {
  content: MessageContent;
  rawOutput: string;
  output: unknown;
}

function serializeToolHandlerResult(result: unknown): SerializedToolResult {
  if (isToolContent(result)) {
    const parts = result.$rejellyContent;
    return {
      content: parts,
      rawOutput: JSON.stringify(parts),
      output: result,
    };
  }

  const rawOutput = typeof result === "string" ? result : (JSON.stringify(result) as string);
  const output = typeof result !== "string" ? result : safeJsonParse(rawOutput);
  return {
    content: rawOutput,
    rawOutput,
    output,
  };
}

interface ExecuteSingleToolCoreResult {
  content: MessageContent;
  rawOutput: string;
  metadata: ToolExecutionResult;
}

/**
 * Result of a successful single-tool run. `handlerResult` is the tool handler's
 * raw return value (the shape callers of `callTool` get back); the remaining
 * fields are the serialized/normalized views the loop path needs.
 */
interface RunSingleToolResult {
  handlerResult: unknown;
  input: JsonObject;
  content: MessageContent;
  rawOutput: string;
  output: unknown;
  contentHash: string;
  fromCache: boolean;
}

/** Build error result for tool-not-found case */
function buildToolNotFoundResult(
  callId: string,
  toolName: string,
  availableToolNames: string[],
): ExecuteSingleToolCoreResult {
  const errorMessage = `Tool "${toolName}" not found. Available tools: ${availableToolNames.join(", ")}`;
  return buildToolErrorResult({
    callId,
    toolName,
    input: null,
    message: errorMessage,
  });
}

function buildToolErrorResult(params: {
  callId: string;
  toolName: string;
  input: JsonValue | null;
  message: string;
  error?: Error;
  duration?: number;
  contentHash?: string;
}): ExecuteSingleToolCoreResult {
  const rawOutput = JSON.stringify({ error: true, message: params.message });
  return {
    content: rawOutput,
    rawOutput,
    metadata: {
      callId: params.callId,
      toolName: params.toolName,
      input: params.input,
      output: { error: true, message: params.message },
      duration: params.duration ?? 0,
      success: false,
      error: toErrorInfo(params.error ?? new Error(params.message)),
      contentHash: params.contentHash,
    },
  };
}

// ============ Core Engine ============

/**
 * Throwing single-tool runner — the only place where tool business logic lives.
 *
 * Callers are responsible for parsing JSON strings before invoking this function.
 * Validates args against the tool's Zod schema, assembles the middleware chain
 * (with cache), executes the handler, validates and serializes the result, and
 * records a journal entry. **Errors propagate** (zod validation, handler throws,
 * `InvalidToolOutputError`): callers that want "errors as tool output" wrap this
 * in `executeSingleToolCore`; callers that want a plain value use `callTool`.
 */
async function runSingleTool(
  tool: ToolDefinition,
  args: JsonObject,
  ctx?: AgentContext,
  toolCallId?: string,
): Promise<RunSingleToolResult> {
  // Validate with Zod schema
  const parseResult = tool.parameters.safeParse(args);
  if (!parseResult.success) {
    const issues = parseResult.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid arguments for tool "${tool.name}": ${issues}`);
  }

  const input = parseResult.data;
  const contentHash = calculateToolContentHash(tool.name, input);
  const journalCallId = ctx ? generateCallId(ctx.parentContext, "tool", tool.name) : undefined;

  // Build tool context for middleware
  const toolContext: ToolContext = {
    toolName: tool.name,
    input,
    parameters: tool.parameters,
    description: tool.description,
    metadata: {
      agentId: ctx?.agentId || "",
      traceId: ctx?.trace?.traceId,
      toolCallId,
      fromCache: false,
    },
    definition: tool,
  };

  // Assemble and execute middleware chain (cache as innermost layer)
  const cacheMiddleware = createCacheMiddleware(input, ctx, {
    journalCallId,
    contentHash,
  });
  const allMiddlewares = [...(tool.middlewares || []), cacheMiddleware];
  const handlerResult = await executeToolWithMiddleware(
    { ...tool, middlewares: allMiddlewares },
    toolContext,
    input,
  );
  assertValidToolOutput(tool.name, handlerResult);

  const serialized = serializeToolHandlerResult(handlerResult);

  // Record journal entry
  if (ctx && journalCallId) {
    recordJournal(ctx, journalCallId, {
      type: "tool",
      input,
      output: serialized.output,
      contentHash,
    });
  }

  return {
    handlerResult,
    input,
    content: serialized.content,
    rawOutput: serialized.rawOutput,
    output: serialized.output,
    contentHash,
    fromCache: toolContext.metadata.fromCache === true,
  };
}

/** Assemble the event/telemetry `ToolExecutionResult` for a successful run. */
function buildToolSuccessMetadata(
  callId: string,
  toolName: string,
  result: RunSingleToolResult,
  duration: number,
): ToolExecutionResult {
  return {
    callId,
    toolName,
    input: result.input,
    output: result.output,
    duration,
    success: true,
    cache: result.fromCache,
    contentHash: result.contentHash,
  };
}

/**
 * Core single-tool executor for the tool-call loop — catches every error into a
 * unified result shape so a failing tool becomes a `role:"tool"` message the
 * model can recover from (errors-as-tool-output). Programmatic single-tool
 * callers should use `callTool` (which lets errors throw) instead.
 */
async function executeSingleToolCore(
  tool: ToolDefinition,
  args: JsonObject,
  callId: string,
  ctx?: AgentContext,
): Promise<ExecuteSingleToolCoreResult> {
  const elapsed = startTimer();

  try {
    const result = await runSingleTool(tool, args, ctx, callId);
    return {
      content: result.content,
      rawOutput: result.rawOutput,
      metadata: buildToolSuccessMetadata(callId, tool.name, result, elapsed()),
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const errorName = err.name && err.name !== "Error" ? `${err.name}: ` : "";
    const errorMessage = `Tool "${tool.name}" execution failed: ${errorName}${err.message}`;
    const duration = elapsed();
    const contentHash = calculateToolContentHash(tool.name, args);
    return buildToolErrorResult({
      callId,
      toolName: tool.name,
      input: args,
      message: errorMessage,
      error: err,
      duration,
      contentHash,
    });
  }
}

// ============ Middleware Engine ============

function composeMiddleware<TArg, TResult>(
  middlewares: Array<(arg: TArg, next: (nextArg: TArg) => Promise<TResult>) => Promise<TResult>>,
  base: (arg: TArg) => Promise<TResult>,
): (arg: TArg) => Promise<TResult> {
  return middlewares.reduceRight<(arg: TArg) => Promise<TResult>>(
    (next, middleware) => (arg) => middleware(arg, next),
    base,
  );
}

/**
 * Execute tool with middleware chain (onion model)
 *
 * Execution order: Static middlewares (from augment) -> Handler
 */
function executeToolWithMiddleware(
  tool: ToolDefinition,
  ctx: ToolContext,
  input: unknown,
): Promise<unknown> {
  const middlewares = tool.middlewares || [];
  const chain = composeMiddleware<void, unknown>(
    middlewares.map((middleware) => async (_arg, next) => middleware.handler(ctx, () => next())),
    async () => tool.handler(input),
  );
  return chain();
}

/**
 * Create cache middleware that checks cache before executing handler.
 * Placed at the innermost layer (before handler).
 */
function createCacheMiddleware(
  input: JsonValue,
  agentCtx: AgentContext | undefined,
  cacheKey: { journalCallId?: string; contentHash: string },
): ToolMiddleware {
  return {
    name: CACHE_MIDDLEWARE_NAME,
    handler: async (ctx: ToolContext, next: () => Promise<unknown>): Promise<unknown> => {
      if (agentCtx && cacheKey.journalCallId) {
        if (agentCtx.snapshot) {
          const entry = getJournalEntry(agentCtx, cacheKey.journalCallId, {
            type: "tool",
            input,
            contentHash: cacheKey.contentHash,
          });
          if (entry) {
            // Cache hit — re-record to avoid cache loss on next snapshot dump
            recordJournal(agentCtx, cacheKey.journalCallId, {
              type: "tool",
              input,
              output: entry.output,
              contentHash: cacheKey.contentHash,
            });
            ctx.metadata.fromCache = true;
            return entry.output;
          }
        }
      }
      ctx.metadata.fromCache = false;
      return await next();
    },
  };
}

/**
 * Internal API for the LLM tool-call loop.
 *
 * Parses JSON arguments from LLM, resolves tool definitions, dispatches
 * each call to the core engine in parallel, and wraps results as
 * role:"tool" messages. Also handles tracing and event reporting.
 */
async function executeToolOutputs(
  toolCalls: ToolCall[],
  toolsOverride?: ToolDefinition[],
): Promise<ToolOutput[]> {
  const ctx = getCurrentContext();
  const toolNames = toolCalls.map((call) => call.name);
  const tools = toolsOverride ?? ctx.draft.tools;

  const toolMiddlewares: MiddlewareInfo[] = [];
  for (const name of toolNames) {
    const tool = tools.find((t) => t.name === name);
    if (tool) toolMiddlewares.push(...getToolMiddlewaresForEvent(tool));
  }

  return withToolExecutionEvents(
    "tools-execute",
    {
      toolNames,
      toolMiddlewares: toolMiddlewares.length > 0 ? toolMiddlewares : undefined,
    },
    async () => {
      const toolMap = new Map<string, ToolDefinition>();
      for (const tool of tools) {
        toolMap.set(tool.name, tool);
      }

      const availableToolNames = Array.from(toolMap.keys());
      const results = await Promise.all(
        toolCalls.map(async (call) => {
          const tool = toolMap.get(call.name);

          if (!tool) {
            return buildToolNotFoundResult(call.id, call.name, availableToolNames);
          }

          let parsedArgs: JsonObject;
          try {
            const rawArgs = call.arguments?.trim() || "{}";
            parsedArgs = JSON.parse(rawArgs);
          } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            const errorMessage = `Invalid JSON arguments for tool "${call.name}": ${err.message}`;
            return buildToolErrorResult({
              callId: call.id,
              toolName: call.name,
              input: null,
              message: errorMessage,
            });
          }

          const result = await executeSingleToolCore(tool, parsedArgs, call.id, ctx);
          if (!result.metadata.success) {
            const output = result.metadata.output;
            const errorMessage =
              output &&
              typeof output === "object" &&
              "message" in (output as Record<string, unknown>)
                ? String((output as Record<string, unknown>).message)
                : "execution failed";
            logger.warn(`Tool "${call.name}" ${errorMessage}`);
          }
          return result;
        }),
      );

      const outputs: ToolOutput[] = toolCalls.map((call, i) => ({
        callId: call.id,
        content: results[i].content,
      }));

      return {
        results: results.map((result) => result.metadata),
        value: outputs,
      };
    },
  );
}

/**
 * tool-call loop with middleware support.
 *
 * This wrapper only affects the tool execution phase after the model has already
 * decided to call tools. It does not mutate prompt inputs or schema.
 *
 * Tools, middlewares, and loop history are read from `options.runtime`, which is
 * required and policy-internal (same gate as `executeTurn`).
 *
 * @param toolCalls
 * @param options
 * @param options.skipLoopMiddleware - Skip tool-call loop middleware and execute tools directly
 */
export async function executeTools(
  toolCalls: ToolCall[],
  options: ExecuteToolsOptions,
): Promise<Message[]> {
  const ctx = getCurrentContext();
  assertRuntimeUsable(options?.runtime, ctx, "executeTools");
  const { runtime, skipLoopMiddleware = false } = options;
  const tools = runtime.tools;
  assertUniqueToolNames(tools, "executeTools");
  const middlewares = runtime.toolCallLoopMiddlewares;

  if (skipLoopMiddleware || middlewares.length === 0) {
    return toolOutputsToMessages(await executeToolOutputs(toolCalls, tools));
  }

  const loopCtx = buildToolCallLoopContext(runtime, ctx.draft.steps, runtime.messages, toolCalls);
  const outputs = await executeWithToolCallLoopMiddleware(
    middlewares,
    loopCtx,
    async (calls) => await executeToolOutputs(calls, tools),
  );
  const filteredOutputs = filterToolOutputsToMatchBatch(toolCalls, outputs);
  assertToolOutputsCoverOriginalCalls(toolCalls, filteredOutputs);
  return toolOutputsToMessages(filteredOutputs);
}

/**
 * External API for user / planner to execute a single tool programmatically.
 *
 * Runs the tool's own middleware chain (`augmentTool` static + `equipTool`
 * dynamic), but **by design does not pass through `equipToolCallLoopMiddleware`**
 * — loop middleware is bound to the promptAgent tool-call loop (model emits a
 * batch of `tool_calls` → framework dispatches), and this manual single-tool
 * path has no such batch/turn context. To apply cross-cutting concerns (auth,
 * retry, rate-limit, logging) here, attach them at the per-tool layer with
 * `equipTool({ middleware })` / `augmentTool`.
 *
 * Unlike the model tool-call loop, this path does **not** turn failures into
 * tool-output messages: errors (zod validation, handler throws,
 * `InvalidToolOutputError`) propagate to the caller.
 *
 * @returns The tool handler's raw return value.
 */
export async function callTool(tool: ToolDefinition, args: JsonObject): Promise<unknown> {
  assertSerializable(args, "callTool");
  const agentCtx = getCurrentContextSafe();

  // No context — execute directly without tracing or events
  if (!agentCtx) {
    const { handlerResult } = await runSingleTool(tool, args);
    return handlerResult;
  }

  const callId = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  const toolMiddlewares = getToolMiddlewaresForEvent(tool);
  return withToolExecutionEvents(
    "tool-execute",
    {
      toolNames: [tool.name],
      toolMiddlewares: toolMiddlewares.length > 0 ? toolMiddlewares : undefined,
    },
    async () => {
      const scopedCtx = getCurrentContext();
      const elapsed = startTimer();
      const result = await runSingleTool(tool, args, scopedCtx);
      return {
        results: [buildToolSuccessMetadata(callId, tool.name, result, elapsed())],
        value: result.handlerResult,
      };
    },
  );
}
