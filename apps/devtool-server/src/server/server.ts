/**
 * DevTool Server (Fastify)
 *
 * Main entry point that assembles all plugins and routes.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { jsonSchemaTransform } from "fastify-type-provider-zod";
import { $ZodType } from "zod/v4/core";
import { MAX_BODY_SIZE } from "../config";
import { initSchema } from "../db/init-schema";
import { aiRoutes } from "../routes/ai";
import { mcpRoutes } from "../routes/mcp";
import { traceRoutes } from "../routes/traces";
import { wsRoutes } from "../routes/ws";

function hasZodSchema(value: unknown): boolean {
  if (value instanceof $ZodType) {
    return true;
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(hasZodSchema);
  }
  return Object.values(value as Record<string, unknown>).some(hasZodSchema);
}

/**
 * Build Fastify server
 */
export async function buildServer() {
  // Initialize database schema
  initSchema();

  const fastify = Fastify({
    logger: true,
    bodyLimit: MAX_BODY_SIZE,
  });

  // Register CORS
  await fastify.register(cors, {
    origin: true, // Allow all origins in dev
  });

  // Register Swagger for API documentation
  await fastify.register(swagger, {
    transform: (input) => (hasZodSchema(input.schema) ? jsonSchemaTransform(input) : input),
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Rejelly DevTool API",
        description: "API for receiving and querying trace events from Rejelly agents",
        version: "0.1.0",
      },
      servers: [
        {
          url: "http://127.0.0.1:5789",
          description: "Development server",
        },
      ],
    },
  });

  // Register Swagger UI
  await fastify.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: false,
    },
    staticCSP: true,
    transformStaticCSP: (header) => header,
  });

  // Register WebSocket plugin
  await fastify.register(websocket);

  // Register business routes
  // All trace routes with unified version prefix
  fastify.register(traceRoutes, { prefix: "/api/v1/traces" });

  // AI routes
  fastify.register(aiRoutes, { prefix: "/api/v1/ai" });

  // MCP routes
  fastify.register(mcpRoutes, { prefix: "/mcp" });

  // WebSocket routes
  fastify.register(wsRoutes);

  // Static UI: resolve candidates for prod (bundled under dist/) vs dev (tsx loading src/) vs optional package public/
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  const prodPath = join(__dirname, "public");
  const devPathDist = join(__dirname, "..", "dist", "public");
  const devPathRoot = join(__dirname, "..", "public");

  let publicPath = "";
  if (existsSync(prodPath)) {
    publicPath = prodPath;
  } else if (existsSync(devPathDist)) {
    publicPath = devPathDist;
  } else if (existsSync(devPathRoot)) {
    publicPath = devPathRoot;
  }

  const hasStatic = publicPath !== "";

  if (hasStatic) {
    fastify.log.info(`Serving static UI from: ${publicPath}`);
    await fastify.register(fastifyStatic, {
      root: publicPath,
      prefix: "/",
    });
  } else {
    fastify.log.warn("No static UI found. Make sure @rejelly/devtool-ui is built.");
  }

  fastify.setNotFoundHandler((request, reply) => {
    const rawUrl = request.raw.url ?? "";
    const pathOnly = rawUrl.split("?")[0] ?? "";

    if (pathOnly.startsWith("/api")) {
      reply.status(404).send({ error: "Not Found" });
      return;
    }
    if (pathOnly.startsWith("/docs")) {
      reply.status(404).send({ error: "Not Found" });
      return;
    }
    if (pathOnly.startsWith("/mcp")) {
      reply.status(404).send({ error: "Not Found" });
      return;
    }
    if (hasStatic && request.method === "GET" && pathOnly !== "/ws") {
      reply.sendFile("index.html");
      return;
    }
    reply.status(404).send({ error: "Not Found" });
  });

  return fastify;
}
