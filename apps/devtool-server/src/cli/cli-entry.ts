#!/usr/bin/env node
/**
 * Global CLI entry (see package.json bin).
 *
 *   rejelly-devtool [--port|-p <n>] [--host <addr>] [--db <path>] [--review]   start the server (default)
 *   rejelly-devtool tools [<tool>] [--list | --describe <t> | --tool <t> --args <json>] [...]
 *
 * Env: REJELLY_DEVTOOL_PORT, REJELLY_DEVTOOL_HOST, REJELLY_DEVTOOL_DB_PATH
 * (used when the matching flag is omitted).
 *
 * Settings flow through the env: the flags below are validated and written to
 * REJELLY_DEVTOOL_* here, then resolved by @config at the point of use. All reads
 * are lazy (@config getters, the lazy db connection in db/drizzle.ts), so there
 * is no import-order constraint — flags just have to be set before the command
 * runs. The server/tools modules are still imported dynamically inside the
 * actions purely to keep startup lean (`--help` / `--version` load neither).
 */

import "dotenv/config";

import cac from "cac";

function fail(message: string): never {
  console.error(`[DevTool Server] ${message}`);
  process.exit(1);
}

interface ServeOptions {
  port?: string | number;
  host?: string;
  db?: string;
  review?: boolean;
}

/** Validate the serve flags and publish them to the env @config reads from. */
function applyServeEnv(options: ServeOptions): void {
  if (options.db) {
    process.env.REJELLY_DEVTOOL_DB_PATH = options.db;
  }

  if (options.port !== undefined) {
    const port = Number.parseInt(String(options.port).trim(), 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      fail(`Invalid --port: ${options.port} (expected 1–65535)`);
    }
    process.env.REJELLY_DEVTOOL_PORT = String(port);
  }

  if (options.host !== undefined) {
    const host = String(options.host).trim();
    if (host === "") {
      fail("Invalid --host: empty string");
    }
    process.env.REJELLY_DEVTOOL_HOST = host;
  }

  // Opt-in self-tracing. Read later by enableDevtoolReviewOnce() when the AI
  // agents are lazily created, so it must be set before the server boots.
  if (options.review) {
    process.env.REJELLY_DEVTOOL_REVIEW = "1";
  }
}

const cli = cac("rejelly-devtool");

cli
  .command("", "Start the DevTool server")
  .option("-p, --port <port>", "Port to listen on (default: REJELLY_DEVTOOL_PORT env or 5789)")
  .option("--host <addr>", "Host to bind (default: REJELLY_DEVTOOL_HOST env or 127.0.0.1)")
  .option(
    "--db <path>",
    "Trace SQLite DB path (default: REJELLY_DEVTOOL_DB_PATH env or ./.rejelly/devtool.sqlite3)",
  )
  .option("--review", "Record the devtool's own agent traces back to this server (self-tracing)")
  .action(async (options: ServeOptions) => {
    // Publish flags to the env, then start; @config getters and the lazy db
    // connection read them at the point of use.
    applyServeEnv(options);
    const { startServer } = await import("../server/start-server");
    try {
      await startServer();
    } catch (err) {
      console.error("[DevTool Server] Error starting server:", err);
      process.exit(1);
    }
  });

cli
  .command(
    "tools [tool]",
    "Run trace-analysis tools against the local trace DB (headless eval harness)",
  )
  .option("--list", "List registered tools")
  .option("--describe <tool>", "Print a tool's JSON Schema and an args example")
  .option("--tool <tool>", "Run one tool by name (default: run all that need no args)")
  .option("--args <json>", "Tool parameter object as JSON")
  .option("--trace-id <traceId>", "Trace ID used as the current trace context (default: latest)")
  .option("--json", "Print structured { tool, args, result } output")
  .option(
    "--db <path>",
    "Trace SQLite DB path (default: REJELLY_DEVTOOL_DB_PATH env or ./.rejelly/devtool.sqlite3)",
  )
  .example("rejelly-devtool tools --list")
  .example("rejelly-devtool tools get_trace_profile --json")
  .action(async (tool: string | undefined, options) => {
    // A bare positional (`tools get_trace_profile`) is the natural way to name a
    // tool, so treat it as --tool. An explicit --tool flag wins if both are given.
    if (tool && !options.tool) {
      options.tool = tool;
    }
    if (options.db) {
      process.env.REJELLY_DEVTOOL_DB_PATH = options.db;
    }
    const { runTools } = await import("./run-tools");
    try {
      await runTools(options);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

cli.help();
cli.version("0.1.0");
cli.parse();
