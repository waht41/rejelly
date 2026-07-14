/**
 * Trace controller - handles HTTP requests for trace operations
 */

import type { TraceEvent } from "@rejelly/core";
import { EVENTS } from "@rejelly/core";
import type { TraceEntryType, TraceStatus } from "@rejelly/devtool-contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { TraceFilterRequest } from "../capabilities/trace-filter/ast";
import { isValidFilterNode } from "../capabilities/trace-filter/validation";
import { broadcastManager } from "../services/broadcast.service";
import { traceService } from "../services/trace.service";

export async function ingestTraces(
  request: FastifyRequest<{ Body: TraceEvent[] }>,
  reply: FastifyReply,
) {
  try {
    const events = request.body;

    if (!Array.isArray(events)) {
      return reply.code(400).send({
        error: "Invalid request body",
        message: "Expected an array of trace events",
      });
    }

    if (events.length === 0) {
      return reply.code(200).send({ ok: true, message: "No events to process" });
    }

    const result = await traceService.ingestEvents(events);

    // 1. 【Detail Channel】Broadcast raw events to clients viewing this trace
    broadcastManager.broadcast(result.traceId, events);

    // 2. 【Overview Channel】Calculate summary and broadcast to list view clients
    // Extract lightweight summary from this batch of events
    const hasEnded = events.some((e) => e.type === EVENTS.AGENT_END);
    const hasError = events.some((e) => {
      if (e.type === EVENTS.ERROR) return true;
      if ("success" in e && e.success === false) return true;
      if ("error" in e && e.error) return true;
      return false;
    });

    broadcastManager.broadcastOverview({
      traceId: result.traceId,
      timestamp: Date.now(),
      hasEnded,
      hasError,
      newSpanCount: events.length,
    });

    return reply
      .code(200)
      .send({ ok: true, traceId: result.traceId, eventCount: result.eventCount });
  } catch (error) {
    request.server.log.error(error, "Error processing traces");

    if (error instanceof Error && error.message.includes("exceeds maximum size")) {
      return reply.code(413).send({
        error: "Trace too large",
        message: error.message,
      });
    }

    return reply.code(500).send({
      error: "Internal server error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function listTraces(
  request: FastifyRequest<{
    Querystring: {
      pageSize?: number;
      page?: number;
      status?: string; // Comma-separated list of statuses
      entryType?: string; // Comma-separated list of entry types
      name?: string;
      isStarred?: boolean;
      startTime?: number;
      endTime?: number;
      order?: "asc" | "desc";
    };
  }>,
  reply: FastifyReply,
) {
  try {
    const {
      pageSize,
      page,
      status: statusStr,
      entryType: entryTypeStr,
      name,
      isStarred,
      startTime,
      endTime,
      order,
    } = request.query;

    // Parse status array
    let status: TraceStatus[] | undefined;
    if (statusStr) {
      const statusList = statusStr.split(",").map((s) => s.trim()) as TraceStatus[];
      status = statusList.filter((s) => ["running", "completed", "failed"].includes(s));
      if (status.length === 0) {
        status = undefined;
      }
    }

    // Parse entryType array
    let entryType: TraceEntryType[] | undefined;
    if (entryTypeStr) {
      const entryTypeList = entryTypeStr.split(",").map((s) => s.trim()) as TraceEntryType[];
      entryType = entryTypeList.filter((s) => ["agent", "script", "unknown"].includes(s));
      if (entryType.length === 0) {
        entryType = undefined;
      }
    }

    // Validate pagination parameters
    if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize < 1)) {
      return reply.code(400).send({
        error: "Invalid parameter",
        message: "pageSize must be a positive integer",
      });
    }

    if (page !== undefined && (!Number.isInteger(page) || page < 1)) {
      return reply.code(400).send({
        error: "Invalid parameter",
        message: "page must be a positive integer",
      });
    }

    // Validate time range
    if (startTime !== undefined && (!Number.isInteger(startTime) || startTime < 0)) {
      return reply.code(400).send({
        error: "Invalid parameter",
        message: "startTime must be a non-negative integer (timestamp in milliseconds)",
      });
    }

    if (endTime !== undefined && (!Number.isInteger(endTime) || endTime < 0)) {
      return reply.code(400).send({
        error: "Invalid parameter",
        message: "endTime must be a non-negative integer (timestamp in milliseconds)",
      });
    }

    if (startTime !== undefined && endTime !== undefined && startTime > endTime) {
      return reply.code(400).send({
        error: "Invalid parameter",
        message: "startTime must be less than or equal to endTime",
      });
    }

    const result = await traceService.listTraces({
      pageSize,
      page,
      status,
      entryType,
      name,
      isStarred,
      startTime,
      endTime,
      order,
    });

    return reply.code(200).send(result);
  } catch (error) {
    request.server.log.error(error, "Error listing traces");
    return reply.code(500).send({
      error: "Internal server error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function isValidTraceFilterRequest(value: unknown): value is TraceFilterRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (!Array.isArray(request.filters)) return false;
  if (
    request.limit !== undefined &&
    (!Number.isInteger(request.limit) || (request.limit as number) < 1)
  ) {
    return false;
  }
  return request.filters.every((filter) => isValidFilterNode(filter, 1));
}

export async function searchTraces(
  request: FastifyRequest<{
    Body: TraceFilterRequest;
  }>,
  reply: FastifyReply,
) {
  try {
    if (!isValidTraceFilterRequest(request.body)) {
      return reply.code(400).send({
        error: "Invalid request body",
        message:
          "Expected TraceFilterRequest with a valid filter AST (root_attr/builtin/model_usage/cost/tool_execution leaves, and/or/not groups)",
      });
    }

    const result = await traceService.searchTraces(request.body);
    return reply.code(200).send(result);
  } catch (error) {
    request.server.log.error(error, "Error searching traces");
    if (error instanceof Error && error.message.includes("Invalid trace search cursor")) {
      return reply.code(400).send({
        error: "Invalid cursor",
        message: error.message,
      });
    }
    if (error instanceof Error && error.message.includes("Unsupported trace filter")) {
      return reply.code(400).send({
        error: "Unsupported filter",
        message: error.message,
      });
    }
    return reply.code(500).send({
      error: "Internal server error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function getTraceEvents(
  request: FastifyRequest<{ Params: { traceId: string } }>,
  reply: FastifyReply,
) {
  try {
    const { traceId } = request.params;
    const events = await traceService.getTraceEvents(traceId);
    return reply.code(200).send(events);
  } catch (error) {
    request.server.log.error(error, "Error getting events");
    return reply.code(500).send({
      error: "Internal server error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function getTraceDetail(
  request: FastifyRequest<{ Params: { traceId: string } }>,
  reply: FastifyReply,
) {
  try {
    const { traceId } = request.params;
    const detail = await traceService.getTraceDetail(traceId);
    if (!detail) {
      return reply.code(404).send({
        error: "Not found",
        message: `Trace ${traceId} not found`,
      });
    }
    return reply.code(200).send(detail);
  } catch (error) {
    request.server.log.error(error, "Error getting trace detail");
    return reply.code(500).send({
      error: "Internal server error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function deleteTrace(
  request: FastifyRequest<{ Params: { traceId: string } }>,
  reply: FastifyReply,
) {
  try {
    const { traceId } = request.params;
    await traceService.deleteTrace(traceId);
    return reply.code(200).send({ ok: true });
  } catch (error) {
    request.server.log.error(error, "Error deleting trace");
    return reply.code(500).send({
      error: "Internal server error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function updateTraceMetadata(
  request: FastifyRequest<{
    Params: { traceId: string };
    Body: {
      name?: string;
      isStarred?: boolean;
      tags?: string[] | null;
    };
  }>,
  reply: FastifyReply,
) {
  try {
    const { traceId } = request.params;
    const { name, isStarred, tags } = request.body;

    await traceService.updateTraceMetadata(traceId, {
      name,
      isStarred,
      tags,
    });

    return reply.code(200).send({ ok: true });
  } catch (error) {
    request.server.log.error(error, "Error updating trace metadata");
    if (error instanceof Error && error.message.includes("not found")) {
      return reply.code(404).send({
        error: "Not found",
        message: error.message,
      });
    }
    return reply.code(500).send({
      error: "Internal server error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
