/**
 * Generate mock trace files for DevTool
 *
 * Runs scenario agents in the catcher (isolated EventBus, errors swallowed),
 * then exports trace events to local .jsonl files under mock-data/, or sends
 * to Jaeger via OTLP when --format=otlp.
 * Run: pnpm gen:mocks [--format=json|otlp] [--scenario=<name>]
 *   --format=json (default): export to mock-data/*.jsonl
 *   --format=otlp: enable OTLP traces and export to Jaeger
 *   --scenario=<name>: run only the named scenario (default: run all)
 */

import {
  createAgent,
  equipInstruction,
  equipTool,
  expectValidator,
  instrument,
  promptAgent,
  type TraceEvent,
} from "@rejelly/core";
import { enableOTLP } from "@rejelly/core/debugger";
import { createMockModel } from "@rejelly/core/testing";
import { z } from "zod";
import { type CatchTraceOptions, catchTraceEvents } from "./core/catcher";
import { exportToJsonl } from "./core/exporters";

const DEFAULT_OTLP_ENDPOINT = "http://localhost:4318/v1/traces";

const SCENARIO_NAMES = [
  "validation-fail",
  "tool-error",
  "model-crash",
  "instrument-alert-logs",
] as const;

function parseFormat(): "json" | "otlp" {
  const arg = process.argv.find((a) => a.startsWith("--format="));
  if (arg) {
    const value = arg.split("=")[1]?.toLowerCase();
    if (value === "otlp") return "otlp";
    if (value === "json") return "json";
  }
  if (process.argv.includes("--otlp")) return "otlp";
  return "json";
}

/** Returns scenario name if --scenario=xxx is set; otherwise undefined (run all). */
function parseScenario(): string | undefined {
  const arg = process.argv.find((a) => a.startsWith("--scenario="));
  if (!arg) return undefined;
  return arg.split("=")[1]?.trim() || undefined;
}

function filterScenarios(scenarios: Scenario[], name: string | undefined): Scenario[] {
  if (!name) return scenarios;
  const found = scenarios.filter((s) => s.name === name);
  if (found.length === 0) {
    console.error(`[gen-mocks] Unknown scenario: "${name}". Valid: ${SCENARIO_NAMES.join(", ")}`);
    process.exit(1);
  }
  return found;
}

interface Scenario {
  name: string;
  run: () => Promise<unknown>;
  /** Optional root runWith options forwarded to catchTraceEvents. */
  catchOptions?: CatchTraceOptions;
}

type MockTraceEvent = TraceEvent & { _seq?: number };

/**
 * Mock files are replayed through server/cache paths that currently key events by
 * spanId+timestamp+type. Make the generated fixture stable for those paths:
 * - `_seq` preserves same-timestamp ordering in server queries.
 * - start events come before same-timestamp sys logs, so logs can attach to their span.
 * - duplicate coarse keys get a tiny timestamp offset instead of being collapsed.
 */
function normalizeMockEvents(events: TraceEvent[]): TraceEvent[] {
  const ordered = events
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      const timeDiff = left.event.timestamp - right.event.timestamp;
      if (timeDiff !== 0) return timeDiff;
      const priorityDiff = eventReplayPriority(left.event) - eventReplayPriority(right.event);
      if (priorityDiff !== 0) return priorityDiff;
      return left.index - right.index;
    });

  const usedCoarseKeys = new Set<string>();

  return ordered.map(({ event }, seq) => {
    const next: MockTraceEvent = {
      ...event,
      trace: { ...event.trace },
      _seq: seq,
    };

    let timestamp = next.timestamp;
    let key = coarseEventKey(next, timestamp);
    while (usedCoarseKeys.has(key)) {
      timestamp = Number((timestamp + 0.001).toFixed(3));
      key = coarseEventKey(next, timestamp);
    }

    next.timestamp = timestamp;
    usedCoarseKeys.add(key);
    return next;
  });
}

function eventReplayPriority(event: TraceEvent): number {
  if (event.type.endsWith(":start")) return 0;
  if (event.type === "sys:log") return 1;
  if (event.type.endsWith(":end")) return 3;
  return 2;
}

function coarseEventKey(event: TraceEvent, timestamp: number): string {
  return `${event.trace.traceId}:${event.trace.spanId}:${timestamp}:${event.type}`;
}

// ---------- 1. Validation Error (validation:fail) ----------
function validationFailScenario(): Scenario {
  const mock = createMockModel();
  mock.setDefaultResponse({ price: -50 });

  const ValidationFailAgent = createAgent({
    id: "validation_error_demo",
    model: mock.adapter,
    handler: async () => {
      expectValidator((data: { price: number }) => {
        if (data.price < 0) return "price cannot be negative, please fix";
        return true;
      });
      return await promptAgent(z.object({ price: z.number() }));
    },
  });

  return { name: "validation-fail", run: () => ValidationFailAgent({}) };
}

// ---------- 2. Tool Execution Error (tools:execute:end success: false) ----------
class APIError extends Error {
  details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.name = "APIError";
    this.details = details;
  }
}

function toolErrorScenario(): Scenario {
  const mock = createMockModel();
  mock
    .when(() => true)
    .thenCallTools([{ id: "call_1", name: "fetch_user", arguments: { id: "user-1" } }]);
  mock.when({ toolName: "fetch_user" }).thenReturn({ status: "done" });

  const ToolErrorAgent = createAgent({
    id: "tool_error_demo",
    model: mock.adapter,
    handler: async () => {
      equipTool({
        name: "fetch_user",
        description: "Fetch user data",
        parameters: z.object({ id: z.string() }),
        handler: async ({ id }) => {
          throw new APIError(`User ${id} not found`, {
            endpoint: "/api/v1/users",
            statusCode: 404,
            requestId: "req-abc-123",
          });
        },
      });
      return await promptAgent(z.object({ status: z.string() }));
    },
  });

  return { name: "tool-error", run: () => ToolErrorAgent({}) };
}

// ---------- 3. Model/Network Failure (model:call:end failed) ----------
function modelCrashScenario(): Scenario {
  const mock = createMockModel();
  mock.when({ input: /crash/i }).thenThrow(new Error("OpenAI API Connection Timeout (504)"));
  mock.setDefaultResponse({ result: "ok" });

  const ModelCrashAgent = createAgent({
    id: "model_crash_demo",
    model: mock.adapter,
    handler: async () => {
      equipInstruction("Respond with topic. If user says crash, trigger crash.");
      return await promptAgent(z.object({ result: z.string() }));
    },
  });

  return { name: "model-crash", run: () => ModelCrashAgent({ topic: "crash" }) };
}

// ---------- 4. Framework Alert Logs (multiple sys:log records on errored instrumentation paths) ----------
function instrumentAlertLogsScenario(): Scenario {
  const mock = createMockModel();
  mock.setDefaultResponse({ status: "ok" });

  const AlertLogsAgent = createAgent({
    id: "instrument_alert_logs_demo",
    model: mock.adapter,
    handler: async () => {
      // sys:log events are bridged automatically for any traced run (see core sys-log-bridge).
      const client = instrument(
        {
          async read(key: string) {
            return { key, value: "cached" };
          },
          async write(_key: string, _value: string) {
            throw new Error("storage write failed");
          },
        },
        {
          name: "alerting-store",
          ops: ["read", "write"],
          derive: {
            call: ({ operation }) => {
              throw new Error(`derive call metadata failed for ${operation}`);
            },
            result: ({ operation }) => {
              throw new Error(`derive result metadata failed for ${operation}`);
            },
            error: ({ operation }) => {
              throw new Error(`derive error metadata failed for ${operation}`);
            },
          },
        },
      );

      await client.read("profile:user-1");
      try {
        await client.write("profile:user-1", "stale");
      } catch {
        // Keep the scenario successful while preserving the instrument error span and logs.
      }

      return { status: "alert-path-covered" };
    },
  });

  return { name: "instrument-alert-logs", run: () => AlertLogsAgent({}) };
}

// ---------- Run all and export to mock-data (json) or Jaeger (otlp) ----------
async function main() {
  const format = parseFormat();
  const scenarioArg = parseScenario();
  const allScenarios: Scenario[] = [
    validationFailScenario(),
    toolErrorScenario(),
    modelCrashScenario(),
    instrumentAlertLogsScenario(),
  ];
  const scenarios = filterScenarios(allScenarios, scenarioArg);

  if (format === "otlp") {
    const disable = enableOTLP({
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_OTLP_ENDPOINT,
      serviceName: "gen-mocks",
    });
    for (const { name, run, catchOptions } of scenarios) {
      try {
        await catchTraceEvents(run, catchOptions ?? {});
        console.log(`[gen-mocks] ${name} -> Jaeger (otlp) ok`);
      } catch (error) {
        console.log(
          `[gen-mocks] ${name} -> Jaeger (otlp) error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await disable();
    return;
  }

  for (const { name, run, catchOptions } of scenarios) {
    const { events, error } = await catchTraceEvents(run, catchOptions ?? {});
    const outPath = await exportToJsonl(normalizeMockEvents(events), { filename: name });
    const status = error
      ? `error: ${error instanceof Error ? error.message : String(error)}`
      : "ok";
    console.log(`[gen-mocks] ${name} -> ${outPath} (${status})`);
  }
}

main().catch((err) => {
  console.error("[gen-mocks]", err);
  process.exit(1);
});
