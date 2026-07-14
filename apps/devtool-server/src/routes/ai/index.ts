/**
 * AI routes - API endpoints for trace analysis operations
 */

import {
  type AnalyzeRequest,
  analyzeRequestSchema,
  apiErrorResponseSchema,
  apiErrorWithCodeResponseSchema,
  type TraceFilterGenerateRequest,
  traceFilterGenerateRequestSchema,
} from "@rejelly/devtool-contracts";
import type { FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod/v4";
import * as aiController from "../../controllers/ai.controller";

export async function aiRoutes(fastify: FastifyInstance) {
  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);

  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Filter AST generation - compile natural language into a TraceFilterRequest AST
  app.post<{ Body: TraceFilterGenerateRequest }>(
    "/filter",
    {
      schema: {
        description:
          "Generate a trace filter AST from a natural-language request. Returns delta messages to round-trip as history for follow-up corrections.",
        tags: ["ai"],
        summary: "AI filter AST generation",
        body: traceFilterGenerateRequestSchema,
        response: {
          400: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorWithCodeResponseSchema,
        },
      },
    },
    async (request, reply) => {
      return aiController.generateFilter(request, reply);
    },
  );

  // AI Analyze endpoint - Stream trace analysis
  app.post<{ Body: AnalyzeRequest }>(
    "/analyze",
    {
      schema: {
        description: "Analyze the current trace with AI and stream the response",
        tags: ["ai"],
        summary: "AI trace analysis stream",
        body: analyzeRequestSchema,
        response: {
          200: z.string().describe("Stream of AI trace analysis updates (Server-Sent Events)"),
          400: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorWithCodeResponseSchema,
        },
      },
    },
    async (request, reply) => {
      return aiController.analyzeStream(request, reply);
    },
  );
}
