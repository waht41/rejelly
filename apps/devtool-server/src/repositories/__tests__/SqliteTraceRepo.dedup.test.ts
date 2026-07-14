/**
 * Regression tests for trace-event ingestion dedup.
 *
 * Guards the bug fixed in eventRowId(): model:call:start/end are the only events
 * carrying a top-level `id`, and that `id` is the model **adapter id** (e.g.
 * "mock-model" / "deepseek-v4-flash"), NOT a unique event id. Keying the SQLite
 * primary key off `event.id` collapsed every model call across every trace onto
 * a single row, so onConflictDoNothing silently dropped all but the first —
 * which erased model-call spans and orphaned the budget:update events parented
 * to them (their parent span no longer existed).
 *
 * Covered:
 *  1. Many model:call events sharing one model id are all stored (the fix).
 *  2. True duplicate deliveries are still deduped idempotently.
 *  3. End-to-end: a small mock-model agent's model:call + budget:update events
 *     all survive ingestion.
 */

import {
  BudgetExceededError,
  createAgent,
  createEventBus,
  equipBudget,
  getContextSignal,
  getGlobalEventBus,
  promptAgent,
  promptChat,
  runWith,
  type TraceEvent,
} from "@rejelly/core";
import { createMockModel } from "@rejelly/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { initSchema } from "../../db/init-schema";
import { traceService } from "../../services/trace.service";
import { getTraceProfile } from "../../services/trace-profile.service";
import { createGetTraceProfileTool } from "../../tools/trace/get-trace-profile-tool";
import { SqliteTraceRepo } from "../SqliteTraceRepo";

const repo = new SqliteTraceRepo();

function sleepWithContextSignal(delayMs: number): Promise<void> {
  const signal = getContextSignal();

  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error("Aborted"));
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeoutId);
      cleanup();
      reject(signal?.reason ?? new Error("Aborted"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

beforeAll(() => {
  // Create tables in the isolated test DB (REJELLY_DEVTOOL_DB_PATH injected by vitest.config.ts).
  initSchema();
});

afterAll(async () => {
  // Best-effort cleanup of the temp db files; the connection stays open (module
  // singleton), so deletion may fail on Windows — ignore in that case.
  const { rm } = await import("node:fs/promises");
  const file = process.env.REJELLY_DEVTOOL_DB_PATH;
  if (!file) return;
  for (const suffix of ["", "-wal", "-shm"]) {
    await rm(`${file}${suffix}`, { force: true }).catch(() => {});
  }
});

/** Build a model:call event the way core emits them: `id` is the adapter id. */
function manualModelCall(kind: "start" | "end", spanId: string, ts: number): TraceEvent {
  const base = {
    // Same adapter id for every call — this is exactly what used to collide.
    id: "mock-model",
    provider: "mock",
    messageCount: 1,
    usedTools: false,
    agentId: "manual-probe",
    timestamp: ts,
    trace: { traceId: "manual-trace", spanId, parentSpanId: "manual-turn" },
  };
  return (kind === "start"
    ? { ...base, type: "model:call:start" }
    : {
        ...base,
        type: "model:call:end",
        rawText: "",
        duration: 1,
        success: true,
        finishReason: "stop",
      }) as unknown as TraceEvent;
}

describe("SqliteTraceRepo ingestion dedup", () => {
  it("stores every model:call event even when they share one adapter id", async () => {
    // 3 calls × (start + end), all with id "mock-model", distinct spans.
    const events: TraceEvent[] = [];
    for (let i = 0; i < 3; i++) {
      events.push(manualModelCall("start", `m${i}`, 1000 + i * 10));
      events.push(manualModelCall("end", `m${i}`, 1001 + i * 10));
    }

    const stored = await repo.insertEvents(events);
    expect(stored).toHaveLength(6);

    const starts = await repo.queryEvents({
      traceId: "manual-trace",
      types: ["model:call:start"],
    });
    const ends = await repo.queryEvents({
      traceId: "manual-trace",
      types: ["model:call:end"],
    });
    expect(starts).toHaveLength(3);
    expect(ends).toHaveLength(3);
  });

  it("dedups true duplicate deliveries idempotently", async () => {
    const dup = manualModelCall("start", "dup-span", 5000);

    const first = await repo.insertEvents([dup]);
    expect(first).toHaveLength(1);

    // Re-deliver the identical event (HTTP retry / reconnect replay).
    const second = await repo.insertEvents([dup, dup]);
    expect(second).toHaveLength(0);

    const rows = await repo.queryEvents({ traceId: "manual-trace", spanId: "dup-span" });
    expect(rows).toHaveLength(1);
  });
});

describe("agent run → repo ingestion (mock model)", () => {
  it("persists every model:call/budget across runs that share one adapter id", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ ok: true });
    mock.setDefaultUsage({ promptTokens: 7, completionTokens: 3 });

    const schema = z.object({ ok: z.boolean() });

    const collected: TraceEvent[] = [];
    const unsubscribe = getGlobalEventBus().subscribe("*", (e) => collected.push(e));

    const Agent = createAgent({
      id: "dedup_probe_agent",
      model: mock.adapter,
      handler: async () => {
        const { data } = await promptChat({ message: { role: "user", content: "ping" }, schema });
        return data;
      },
    });

    try {
      // Three independent runs → three traces, each one model:call, all id "mock-model".
      // The old bug was global (PK keyed on the model id), so cross-trace collisions matter.
      await Agent({});
      await Agent({});
      await Agent({});
    } finally {
      unsubscribe();
    }

    expect(mock.calls.count()).toBe(3);

    const emittedStarts = collected.filter((e) => e.type === "model:call:start");
    const emittedBudgets = collected.filter((e) => e.type === "budget:update");
    expect(emittedStarts).toHaveLength(3);
    expect(emittedBudgets).toHaveLength(3);

    // No duplicate deliveries here, so every collected event must be stored —
    // pre-fix the model:call events (shared id "mock-model") collapsed onto one row.
    const stored = await repo.insertEvents(collected);
    expect(stored).toHaveLength(collected.length);

    // Each run's model:call survives in the DB, keyed per trace.
    for (const start of emittedStarts) {
      const rows = await repo.queryEvents({
        traceId: start.trace.traceId,
        types: ["model:call:start"],
      });
      expect(rows).toHaveLength(1);
    }
  });
});

describe("trace summary endReason ingestion", () => {
  async function runCollectingEvents(run: (events: TraceEvent[]) => Promise<void>): Promise<{
    traceId: string;
    events: TraceEvent[];
  }> {
    const events: TraceEvent[] = [];

    await run(events);

    const traceId = events[0]?.trace.traceId;
    expect(traceId).toBeTruthy();
    await traceService.ingestEvents(events);
    return { traceId: traceId!, events };
  }

  it("persists budget_exceeded when a real BudgetExceededError reaches runWith:end", async () => {
    const mock = createMockModel();
    mock
      .when(() => true)
      .thenReturn({ result: "ok" })
      .withUsage({ promptTokens: 100, completionTokens: 50 });

    const Agent = createAgent({
      id: "budget_exceeded_probe",
      model: mock.adapter,
      handler: async () => {
        equipBudget({
          onUpdate: ({ aggregate }) => {
            if (aggregate.totalTokens > 100) {
              throw new BudgetExceededError({
                kind: "tokens",
                current: aggregate.totalTokens,
                limit: 100,
              });
            }
          },
        });
        await promptAgent(z.object({ result: z.string() }));
      },
    });

    const { traceId } = await runCollectingEvents(async (_events) => {
      const eventBus = createEventBus();
      eventBus.subscribe("*", (event) => _events.push(event));
      await expect(runWith(async () => Agent({}), { eventBus })).rejects.toThrow(
        /Token limit exceeded/,
      );
    });

    const detail = await traceService.getTraceDetail(traceId);
    expect(detail?.status).toBe("failed");
    expect(detail?.endReason).toBe("budget_exceeded");
    expect(detail?.errorFull).toContain('"name":"BudgetExceededError"');
    expect(detail?.errorFull).toContain('"kind":"tokens"');

    const profile = await getTraceProfile(traceId);
    expect(profile.summary.endReason).toBe("budget_exceeded");

    const profileText = await createGetTraceProfileTool(traceId).handler({});
    expect(profileText).toContain("- end_reason: budget_exceeded");
  });

  it("persists interrupted when an external abort reaches runWith:end", async () => {
    const Agent = createAgent({
      id: "interrupted_probe",
      handler: async () => {
        await sleepWithContextSignal(10_000);
      },
    });

    const { traceId } = await runCollectingEvents(async (_events) => {
      const eventBus = createEventBus();
      eventBus.subscribe("*", (event) => _events.push(event));
      const controller = new AbortController();
      const abortError = new Error("Stopped by user (Ctrl+C)");
      abortError.name = "AbortError";
      setTimeout(() => controller.abort(abortError), 10);

      await expect(
        runWith(async () => Agent({}), { eventBus, signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
    });

    const detail = await traceService.getTraceDetail(traceId);
    expect(detail?.status).toBe("failed");
    expect(detail?.endReason).toBe("interrupted");
    expect(detail?.errorFull).toContain('"name":"AbortError"');

    const profile = await getTraceProfile(traceId);
    expect(profile.summary.endReason).toBe("interrupted");

    const profileText = await createGetTraceProfileTool(traceId).handler({});
    expect(profileText).toContain("- end_reason: interrupted");
  });
});

describe("trace summary tool execution ingestion", () => {
  it("persists per-tool executions from tools:execute:end without budget tool usage", async () => {
    const traceId = `tool-execution-summary-${Date.now()}`;
    const events = [
      {
        type: "tools:execute:end",
        agentId: "tool_execution_probe",
        timestamp: Date.now(),
        trace: {
          traceId,
          spanId: "tools-execute-span",
          parentSpanId: "agent-span",
        },
        toolCallsCount: 3,
        toolNames: ["search", "search", "read"],
        successCount: 2,
        failureCount: 1,
        duration: 30,
        success: false,
        toolResults: [
          {
            callId: "call-1",
            toolName: "search",
            input: { q: "alpha" },
            output: { ok: true },
            duration: 7,
            success: true,
            cache: true,
            contentHash: "h1",
          },
          {
            callId: "call-2",
            toolName: "search",
            input: { q: "beta" },
            output: { error: true },
            duration: 11,
            success: false,
            error: { name: "Error", message: "failed" },
            contentHash: "h2",
          },
          {
            callId: "call-3",
            toolName: "read",
            input: { path: "README.md" },
            output: "ok",
            duration: 5,
            success: true,
            contentHash: "h3",
          },
        ],
      },
    ] as unknown as TraceEvent[];

    await traceService.ingestEvents(events);

    const detail = await traceService.getTraceDetail(traceId);
    expect(detail?.toolCallCount).toBe(3);
    expect(detail?.toolUsage).toBeNull();

    const executions = JSON.parse(detail?.toolExecutions ?? "{}") as Record<
      string,
      {
        callCount: number;
        successCount: number;
        failureCount: number;
        cacheCount: number;
        totalOutputChars: number;
      }
    >;
    expect(executions.search).toEqual({
      callCount: 2,
      successCount: 1,
      failureCount: 1,
      totalOutputChars:
        JSON.stringify({ ok: true }).length + JSON.stringify({ error: true }).length,
      cacheCount: 1,
    });
    expect(executions.read).toEqual({
      callCount: 1,
      successCount: 1,
      failureCount: 0,
      totalOutputChars: 2,
      cacheCount: 0,
    });

    const catalog = await traceService.getTraceFilterCatalog();
    expect(
      catalog.toolExecutions.some(
        (entry) =>
          entry.tool === "search" &&
          entry.callCount >= 2 &&
          entry.successCount >= 1 &&
          entry.failureCount >= 1,
      ),
    ).toBe(true);

    const fromBeginning = { from: new Date(0).toISOString() };
    const searchExistsResult = await traceService.searchTraces({
      timeRange: fromBeginning,
      filters: [{ kind: "tool_execution", tool: "search", op: "exists" }],
    });
    expect(searchExistsResult.items.some((item) => item.traceId === traceId)).toBe(true);

    const failureThresholdResult = await traceService.searchTraces({
      timeRange: fromBeginning,
      filters: [
        {
          kind: "tool_execution",
          tool: "search",
          field: "failureCount",
          op: "gte",
          value: 1,
        },
      ],
    });
    expect(failureThresholdResult.items.some((item) => item.traceId === traceId)).toBe(true);

    const tooManyFailuresResult = await traceService.searchTraces({
      timeRange: fromBeginning,
      filters: [
        {
          kind: "tool_execution",
          tool: "search",
          field: "failureCount",
          op: "gt",
          value: 1,
        },
      ],
    });
    expect(tooManyFailuresResult.items.some((item) => item.traceId === traceId)).toBe(false);
  });
});

describe("trace summary model usage filters", () => {
  it("searches traces by model_usage exists and count", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ ok: true });
    mock.setDefaultUsage({ promptTokens: 7, completionTokens: 3 });

    const schema = z.object({ ok: z.boolean() });
    const Agent = createAgent({
      id: "model_usage_filter_probe",
      model: mock.adapter,
      handler: async () => {
        await promptChat({ message: { role: "user", content: "ping" }, schema });
      },
    });

    const events: TraceEvent[] = [];
    const eventBus = createEventBus();
    eventBus.subscribe("*", (event) => events.push(event));

    await runWith(async () => Agent({}), { eventBus });
    const traceId = events[0]?.trace.traceId;
    expect(traceId).toBeTruthy();
    await traceService.ingestEvents(events);

    const detail = await traceService.getTraceDetail(traceId!);
    const usage = JSON.parse(detail?.llmUsage ?? "{}") as Record<string, { count: number }>;
    const model = Object.keys(usage)[0];
    expect(model).toBeTruthy();
    expect(usage[model].count).toBe(1);

    const catalog = await traceService.getTraceFilterCatalog();
    expect(catalog.models.some((entry) => entry.model === model && entry.callCount >= 1)).toBe(
      true,
    );
    const costs = JSON.parse(detail?.costs ?? "{}") as Record<string, number>;
    const costUnit = Object.keys(costs)[0]!;
    expect(costUnit).toBeTruthy();
    expect(costs[costUnit]).toBeGreaterThan(0);
    expect(
      catalog.costs.some((entry) => entry.unit === costUnit && entry.totalValue >= costs[costUnit]),
    ).toBe(true);

    const fromBeginning = { from: new Date(0).toISOString() };
    const existsResult = await traceService.searchTraces({
      timeRange: fromBeginning,
      filters: [{ kind: "model_usage", model, op: "exists" }],
    });
    expect(existsResult.items.some((item) => item.traceId === traceId)).toBe(true);

    const countResult = await traceService.searchTraces({
      timeRange: fromBeginning,
      filters: [{ kind: "model_usage", model, field: "count", op: "gte", value: 1 }],
    });
    expect(countResult.items.some((item) => item.traceId === traceId)).toBe(true);

    const tooHighResult = await traceService.searchTraces({
      timeRange: fromBeginning,
      filters: [{ kind: "model_usage", model, field: "count", op: "gt", value: 1 }],
    });
    expect(tooHighResult.items.some((item) => item.traceId === traceId)).toBe(false);

    const costExistsResult = await traceService.searchTraces({
      timeRange: fromBeginning,
      filters: [{ kind: "cost", unit: costUnit, op: "exists" }],
    });
    expect(costExistsResult.items.some((item) => item.traceId === traceId)).toBe(true);

    const costThresholdResult = await traceService.searchTraces({
      timeRange: fromBeginning,
      filters: [{ kind: "cost", unit: costUnit, op: "gte", value: costs[costUnit] }],
    });
    expect(costThresholdResult.items.some((item) => item.traceId === traceId)).toBe(true);

    const tooExpensiveResult = await traceService.searchTraces({
      timeRange: fromBeginning,
      filters: [{ kind: "cost", unit: costUnit, op: "gt", value: costs[costUnit] }],
    });
    expect(tooExpensiveResult.items.some((item) => item.traceId === traceId)).toBe(false);
  });
});
