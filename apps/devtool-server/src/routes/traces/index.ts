/**
 * Trace routes - API endpoints for trace operations
 */

import type { TraceEvent } from "@rejelly/core";
import {
  apiErrorResponseSchema,
  type ListTracesQuery,
  listTracesQuerySchema,
  listTracesResponseSchema,
  type TraceFilterRequest,
  traceDetailSchema,
  traceFilterRequestSchema,
  traceSummaryPatchSchema,
} from "@rejelly/devtool-contracts";
import type { FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod/v4";
import * as traceController from "../../controllers/trace.controller";

const okResponseSchema = z.object({
  ok: z.boolean(),
});

const traceParamsSchema = z.object({
  traceId: z.string(),
});

const traceEventSchema = z.record(z.string(), z.unknown());

export async function traceRoutes(fastify: FastifyInstance) {
  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);

  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get<{ Querystring: ListTracesQuery }>(
    "/",
    {
      schema: {
        description: "Get list of trace summaries with filtering and pagination",
        tags: ["traces"],
        summary: "List traces",
        querystring: listTracesQuerySchema,
        response: {
          200: listTracesResponseSchema,
          400: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      return traceController.listTraces(request, reply);
    },
  );

  app.post<{ Body: TraceFilterRequest }>(
    "/search",
    {
      schema: {
        description: "Search trace summaries using a structured filter AST",
        tags: ["traces"],
        summary: "Search traces",
        body: traceFilterRequestSchema,
        response: {
          200: listTracesResponseSchema,
          400: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      return traceController.searchTraces(request, reply);
    },
  );

  // Get Trace Events (must be before /:traceId to avoid route conflict)
  app.get(
    "/:traceId/events",
    {
      schema: {
        description: "Get all events for a specific trace",
        tags: ["traces"],
        summary: "Get trace events",
        params: traceParamsSchema,
        response: {
          200: z.array(traceEventSchema),
          500: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      return traceController.getTraceEvents(
        request as unknown as Parameters<typeof traceController.getTraceEvents>[0],
        reply,
      );
    },
  );

  app.get(
    "/:traceId",
    {
      schema: {
        description: "Get trace summary detail with full output and error data",
        tags: ["traces"],
        summary: "Get trace detail",
        params: traceParamsSchema,
        response: {
          200: traceDetailSchema,
          404: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      return traceController.getTraceDetail(
        request as unknown as Parameters<typeof traceController.getTraceDetail>[0],
        reply,
      );
    },
  );

  app.delete(
    "/:traceId",
    {
      schema: {
        description: "Delete a trace",
        tags: ["traces"],
        summary: "Delete trace",
        params: traceParamsSchema,
        response: {
          200: okResponseSchema,
          500: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      return traceController.deleteTrace(
        request as unknown as Parameters<typeof traceController.deleteTrace>[0],
        reply,
      );
    },
  );

  app.patch(
    "/:traceId",
    {
      schema: {
        description: "Update trace metadata (name, isStarred, tags)",
        tags: ["traces"],
        summary: "Update trace metadata",
        params: traceParamsSchema,
        body: traceSummaryPatchSchema,
        response: {
          200: okResponseSchema,
          404: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      return traceController.updateTraceMetadata(
        request as unknown as Parameters<typeof traceController.updateTraceMetadata>[0],
        reply,
      );
    },
  );

  app.post<{ Body: TraceEvent[] }>(
    "/",
    {
      schema: {
        description: "Send trace events from agent to server",
        tags: ["traces"],
        summary: "Post trace events",
        body: z.array(traceEventSchema),
        response: {
          200: okResponseSchema.extend({
            traceId: z.string().optional(),
            eventCount: z.number().optional(),
            message: z.string().optional(),
          }),
          400: apiErrorResponseSchema,
          413: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      return traceController.ingestTraces(request, reply);
    },
  );
}
