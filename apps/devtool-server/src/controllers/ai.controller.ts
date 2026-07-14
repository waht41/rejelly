/**
 * AI controller - HTTP handlers for trace analysis operations
 * (filter AST generation + streaming analyze).
 */

import type { Message } from "@rejelly/core";
import type {
  AnalyzeCompleteResponse,
  AnalyzeErrorUpdate,
  AnalyzeReasoningDeltaUpdate,
  AnalyzeRequest,
  AnalyzeTextDeltaUpdate,
  AnalyzeToolCallUpdate,
  TraceFilterGenerateContext,
  TraceFilterGenerateRequest,
} from "@rejelly/devtool-contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import type {
  CurrentTraceContext,
  FilterAgentResponse,
  FilterAgentTimeRange,
} from "../agents/filter-agent";
import { getSharedAgents } from "../agents/registry";
import { getMissingAiEnvVars } from "../agents/shared";
import type { TraceFilterRequest, TraceFilterValue } from "../capabilities/trace-filter/ast";
import { isValidFilterNode } from "../capabilities/trace-filter/validation";
import { traceService } from "../services/trace.service";

type PublicFilterTimeRange =
  | { type: "preset"; preset: "1h" | "24h" | "7d" | "30d" }
  | { type: "range"; from?: string; to?: string };

type PublicFilterResponse = Omit<FilterAgentResponse, "time_range"> & {
  time_range?: PublicFilterTimeRange;
};

/**
 * Returns a 503 with a user-facing message when required AI env vars are
 * missing, so the UI shows a setup hint instead of an upstream auth error.
 * Returns null when the configuration is complete.
 */
function buildAiNotConfiguredPayload() {
  const missing = getMissingAiEnvVars();
  if (missing.length === 0) {
    return null;
  }
  return {
    error: "AI not configured",
    code: "AI_NOT_CONFIGURED",
    message: `AI features are not configured: missing environment variable ${missing.join(
      ", ",
    )}. Set it for the devtool server (e.g. in .env) and restart.`,
  };
}

function isTraceFilterValue(value: unknown): value is TraceFilterValue {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function isTraceTimePreset(value: unknown): value is "1h" | "24h" | "7d" | "30d" {
  return value === "1h" || value === "24h" || value === "7d" || value === "30d";
}

function parseContextNow(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function timezoneOffsetFromTimestamp(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const match = value.match(/(Z|[+-]\d{2}:\d{2})$/);
  return match?.[1] ?? null;
}

function localTimestampFromTimestamp(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:Z|[+-]\d{2}:\d{2})$/);
  return match?.[1] ?? null;
}

function localToOffsetIso(value: unknown, offset: string | null): string | undefined {
  if (typeof value !== "string" || !offset) {
    return undefined;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)) {
    return undefined;
  }
  const withOffset = `${value}${offset}`;
  return Number.isFinite(Date.parse(withOffset)) ? withOffset : undefined;
}

function normalizeFilterTimeResponse(
  response: FilterAgentResponse,
  now: string | null,
): PublicFilterResponse {
  const offset = timezoneOffsetFromTimestamp(now);
  const { time_range: timeRange, ...rest } = response;
  const publicTimeRange = normalizeFilterTimeRange(timeRange, offset);

  return {
    ...rest,
    ...(publicTimeRange ? { time_range: publicTimeRange } : {}),
  };
}

function normalizeFilterTimeRange(
  timeRange: FilterAgentTimeRange | undefined,
  offset: string | null,
): PublicFilterTimeRange | undefined {
  if (!timeRange) {
    return undefined;
  }
  if (timeRange.type === "preset") {
    return { type: "preset", preset: timeRange.preset };
  }

  const from = localToOffsetIso(timeRange.from_local, offset);
  const to = localToOffsetIso(timeRange.to_local, offset);
  return from || to
    ? {
        type: "range",
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      }
    : undefined;
}

function parseCurrentFilterRequest(value: unknown): TraceFilterRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.filters) || !candidate.filters.every(isValidFilterNode)) {
    return null;
  }

  const request: TraceFilterRequest = {
    filters: candidate.filters,
  };

  if (
    candidate.timeRange &&
    typeof candidate.timeRange === "object" &&
    !Array.isArray(candidate.timeRange)
  ) {
    const timeRange = candidate.timeRange as Record<string, unknown>;
    request.timeRange = {};
    if (isTraceTimePreset(timeRange.preset)) {
      request.timeRange.preset = timeRange.preset;
    }
    if (typeof timeRange.from === "string") {
      request.timeRange.from = timeRange.from;
    }
    if (typeof timeRange.to === "string") {
      request.timeRange.to = timeRange.to;
    }
  }

  if (typeof candidate.limit === "number" && Number.isFinite(candidate.limit)) {
    request.limit = candidate.limit;
  }
  if (typeof candidate.cursor === "string") {
    request.cursor = candidate.cursor;
  }

  return request;
}

async function buildCurrentTraceContext(
  context: TraceFilterGenerateContext | null | undefined,
): Promise<CurrentTraceContext | null> {
  const traceId = context?.traceId;
  if (typeof traceId !== "string" || traceId.length === 0) {
    return null;
  }

  const detail = await traceService.getTraceDetail(traceId);
  if (!detail) {
    return { traceId, attrs: [] };
  }

  const attrs = Object.entries(detail.attributes ?? {})
    .filter((entry): entry is [string, TraceFilterValue] => isTraceFilterValue(entry[1]))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({ key, value }));

  return { traceId, attrs };
}

export async function generateFilter(
  request: FastifyRequest<{
    Body: TraceFilterGenerateRequest;
  }>,
  reply: FastifyReply,
) {
  const prompt = request.body.prompt?.trim();
  if (!prompt) {
    return reply.code(400).send({
      error: "Invalid request body",
      message: "prompt must be a non-empty string",
    });
  }

  const notConfigured = buildAiNotConfiguredPayload();
  if (notConfigured) {
    return reply.code(503).send(notConfigured);
  }

  try {
    const catalog = await traceService.getTraceFilterCatalog();
    const currentTrace = await buildCurrentTraceContext(request.body.context);
    const currentRequest = parseCurrentFilterRequest(request.body.context?.currentRequest);
    const now = parseContextNow(request.body.context?.now);
    const agentNow = localTimestampFromTimestamp(now);
    const response = await getSharedAgents().filter({
      prompt,
      history: request.body.history as unknown as Message[] | undefined,
      catalog,
      currentTrace,
      currentRequest,
      now: agentNow,
    });
    return reply.code(200).send(normalizeFilterTimeResponse(response, now));
  } catch (error) {
    request.server.log.error(error, "Error generating filter AST");
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("All attempts exhausted")) {
      return reply.code(422).send({
        error: "Generation failed",
        message: "Could not produce a valid filter AST for this request",
      });
    }
    return reply.code(500).send({
      error: "Internal server error",
      message,
    });
  }
}

export async function analyzeStream(
  request: FastifyRequest<{
    Body: AnalyzeRequest;
  }>,
  reply: FastifyReply,
) {
  // Log request parameters
  request.server.log.info(
    {
      question: request.body.question,
      historyCount: request.body.history?.length ?? 0,
      context: request.body.context,
    },
    "AI analyze request received",
  );

  const notConfigured = buildAiNotConfiguredPayload();
  if (notConfigured) {
    return reply.code(503).send(notConfigured);
  }

  // Hijack the reply to take full control of the response
  reply.hijack();

  // Set headers for Server-Sent Events (SSE)
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // Disable nginx buffering
  });

  try {
    // Execute agent with native model reasoning streaming
    // Use shared agent instance for better performance and connection pool reuse
    const response = await getSharedAgents().analyze({
      question: request.body.question,
      history: request.body.history,
      context: request.body.context,
      handleReasoningDelta: (delta) => {
        const update = {
          type: "reasoning_delta",
          content: delta,
        } satisfies AnalyzeReasoningDeltaUpdate;
        reply.raw.write(`data: ${JSON.stringify(update)}\n\n`);
      },
      handleToolCall: (toolName, toolCallId) => {
        const update = {
          type: "tool_call",
          toolName,
          toolCallId,
        } satisfies AnalyzeToolCallUpdate;
        reply.raw.write(`data: ${JSON.stringify(update)}\n\n`);
      },
      handleTextDelta: (content) => {
        const update = {
          type: "text_delta",
          content,
        } satisfies AnalyzeTextDeltaUpdate;
        reply.raw.write(`data: ${JSON.stringify(update)}\n\n`);
      },
    });

    // Send final complete response
    const finalUpdate = {
      complete: true,
      response,
    } satisfies AnalyzeCompleteResponse;
    reply.raw.write(`data: ${JSON.stringify(finalUpdate)}\n\n`);

    // Send done signal
    reply.raw.write("data: [DONE]\n\n");
  } catch (error) {
    request.server.log.error(error, "Error processing AI analysis");

    // Status line was already sent as 200, so a mid-stream failure can only
    // be reported in-band. Use the same `type` discriminator as other frames.
    const errorUpdate = {
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    } satisfies AnalyzeErrorUpdate;
    reply.raw.write(`data: ${JSON.stringify(errorUpdate)}\n\n`);
    reply.raw.write("data: [DONE]\n\n");
  }

  // End the response
  reply.raw.end();

  // Return reply to tell Fastify "I've taken control, don't manage it"
  return reply;
}
