/**
 * Start HTTP server (shared by dev entry and CLI binary).
 */

import "dotenv/config";

import { getServerHost, getServerPort } from "../config";
import { buildServer } from "./server";

/**
 * Listen on the port/host resolved by @config (CLI flag → REJELLY_DEVTOOL_PORT/HOST
 * env → defaults). Resolves when listening.
 */
export async function startServer() {
  const port = getServerPort();
  const host = getServerHost();

  const server = await buildServer();

  await server.listen({ port, host });

  console.log(`[DevTool Server] Listening on http://${host}:${port}`);
  console.log(`[DevTool Server] API Documentation: http://${host}:${port}/docs`);
  console.log(`[DevTool Server] Trace events endpoint: http://${host}:${port}/api/v1/traces`);
  console.log(`[DevTool Server] WebSocket endpoint: ws://${host}:${port}/ws`);

  const shutdown = (signal: string) => {
    console.log(`\n[DevTool Server] Received ${signal}, shutting down...`);
    process.exit(0);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}
