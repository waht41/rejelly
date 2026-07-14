/**
 * Configuration constants and environment variables.
 *
 * Single source of truth for every env-derived setting: the env-var names and
 * their defaults live here once, so the entry binaries (@cli), the boot layer
 * (@server) and the AI self-trace layer (@agents) never re-read process.env with
 * their own copy of the defaults.
 *
 * The vars are REJELLY_DEVTOOL_*-namespaced so a global `rejelly-devtool` install
 * never collides with the host project's own PORT/HOST/DB_PATH when dotenv loads
 * the cwd .env. The CLI flags (--port/--host/--db) write these vars (see
 * cli/cli-entry.ts), so flag values flow through the same resolution.
 *
 * Everything is exposed as getters: each is read at the point of use (server
 * start, self-trace, first DB query), when the env is already populated, so
 * resolving on each call frees every reader from depending on import order. The
 * db connection is opened lazily (db/drizzle.ts), so even the db path no longer
 * has to be fixed at import time.
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Maximum spans per trace
export const MAX_TRACE_SIZE = 10_000;

// Maximum HTTP request body size in bytes. Fastify defaults to 1 MiB, which a single
// batch carrying base64 multimodal content (e.g. screenshots in TurnStartEvent.messages)
// easily exceeds, producing a non-retryable 413 that silently drops events. Raised as a
// stopgap; the real fix externalizes base64 at the export boundary (see ISSUE-0020).
export const MAX_BODY_SIZE = 16 * 1024 * 1024; // 16 MiB

export const DEFAULT_PORT = 5789;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_DB_PATH = "./.rejelly/devtool.sqlite3";

export function getDbPath(): string {
  return process.env.REJELLY_DEVTOOL_DB_PATH || DEFAULT_DB_PATH;
}

export function getAbsoluteDbPath(): string {
  return resolve(getDbPath());
}

export function ensureDbDirectory(): void {
  mkdirSync(dirname(getAbsoluteDbPath()), { recursive: true });
}

export function getServerPort(): number {
  return process.env.REJELLY_DEVTOOL_PORT
    ? Number.parseInt(process.env.REJELLY_DEVTOOL_PORT, 10)
    : DEFAULT_PORT;
}

export function getServerHost(): string {
  return process.env.REJELLY_DEVTOOL_HOST || DEFAULT_HOST;
}
