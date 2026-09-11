import {
  augmentModel,
  createAgent,
  createEventBus,
  EVENTS,
  type ModelAdapter,
  ModelCallError,
  promptChat,
  runWith,
  type StreamEvent,
} from "@rejelly/core";
import { describe, expect, it } from "vitest";
import { readModelRetryMetrics } from "../../shared/model/observation/modelRetryMetrics";
import { addRetryJitter, type ModelRetryNotice, withRetry } from "./withRetry";

async function collect(stream: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function transientError(
  code: "connection_error" | "rate_limit" | "server_error" | "timeout",
): ModelCallError {
  return new ModelCallError("transient", {
    modelId: "test-model",
    code,
  });
}

async function* throwBeforeYield(error: unknown): AsyncGenerator<StreamEvent> {
  if (Date.now() < 0) {
    yield { type: "text", content: "unreachable" };
  }
  throw error;
}

describe("model composition withRetry", () => {
  it("adds bounded positive jitter to retry delays", () => {
    expect(addRetryJitter(1_000, 30_000, 0.25, () => 0)).toBe(1_000);
    expect(addRetryJitter(1_000, 30_000, 0.25, () => 0.5)).toBe(1_125);
    expect(addRetryJitter(30_000, 30_000, 0.25, () => 1)).toBe(30_000);
  });

  it("retries retryable ModelCallError before the first yielded event", async () => {
    let calls = 0;
    const adapter: ModelAdapter = {
      id: "test-model",
      stream: async function* () {
        calls += 1;
        if (calls === 1) {
          throw transientError("rate_limit");
        }
        yield { type: "text", content: "ok" };
      },
    };

    const model = augmentModel(adapter, [withRetry({ maxAttempts: 2, initialDelayMs: 0 })]);

    await expect(collect(model.stream([]))).resolves.toEqual([{ type: "text", content: "ok" }]);
    expect(calls).toBe(2);
  });

  it("attaches physical attempt metrics to the logical Model Call span", async () => {
    let calls = 0;
    const eventBus = createEventBus();
    const modelEnds: Array<{ trace: { attributes?: Readonly<Record<string, unknown>> } }> = [];
    eventBus.subscribe(EVENTS.MODEL_CALL_END, (event) => modelEnds.push(event));
    const adapter: ModelAdapter = {
      id: "test-model",
      stream: async function* () {
        calls += 1;
        if (calls === 1) throw transientError("rate_limit");
        yield { type: "text", content: "ok" };
        yield { type: "finish", finishReason: "stop" };
      },
    };
    const model = augmentModel(adapter, [withRetry({ maxAttempts: 2, initialDelayMs: 0 })]);
    const agent = createAgent({
      id: "retry-metrics-agent",
      model,
      handler: async () => promptChat({ message: { role: "user", content: "hello" } }),
    });

    await runWith(() => agent({}), { eventBus });

    expect(readModelRetryMetrics(modelEnds[0]?.trace.attributes)).toMatchObject({
      attempts: [
        { attempt: 1, status: "failed", errorCode: "rate_limit" },
        { attempt: 2, status: "succeeded" },
      ],
      totalRetryDelayMs: expect.any(Number),
    });
  });

  it("waits through connection failures without consuming the transient retry budget", async () => {
    let calls = 0;
    const notices: string[] = [];
    const adapter: ModelAdapter = {
      id: "test-model",
      stream: async function* () {
        calls += 1;
        if (calls <= 2) throw transientError("connection_error");
        if (calls === 3) throw transientError("server_error");
        yield { type: "text", content: "recovered" };
      },
    };

    const model = augmentModel(adapter, [
      withRetry({
        maxAttempts: 2,
        initialDelayMs: 0,
        connectionRetry: "unbounded",
        connectionInitialDelayMs: 0,
        onRetry: (notice) => notices.push(`${notice.type}:${notice.kind}`),
      }),
    ]);

    await expect(collect(model.stream([]))).resolves.toEqual([
      { type: "text", content: "recovered" },
    ]);
    expect(calls).toBe(4);
    expect(notices).toEqual([
      "retry_wait:connection",
      "attempt_start:connection",
      "retry_wait:connection",
      "attempt_start:connection",
      "retry_wait:transient",
      "attempt_start:transient",
    ]);
  });

  it("reports retry wait before the next physical attempt starts", async () => {
    let calls = 0;
    const notices: ModelRetryNotice[] = [];
    const adapter: ModelAdapter = {
      id: "test-model",
      stream: async function* () {
        calls += 1;
        if (calls === 1) throw transientError("server_error");
        yield { type: "text", content: "ok" };
      },
    };
    const model = augmentModel(adapter, [
      withRetry({
        maxAttempts: 3,
        initialDelayMs: 0,
        onRetry: (notice) => notices.push(notice),
      }),
    ]);

    await collect(model.stream([]));

    expect(notices).toEqual([
      {
        type: "retry_wait",
        kind: "transient",
        attempt: 2,
        maxAttempts: 3,
        delayMs: 0,
        errorCode: "server_error",
      },
      {
        type: "attempt_start",
        kind: "transient",
        attempt: 2,
        maxAttempts: 3,
        errorCode: "server_error",
      },
    ]);
  });

  it("bounds connection retries for non-interactive callers", async () => {
    let calls = 0;
    const adapter: ModelAdapter = {
      id: "test-model",
      stream() {
        calls += 1;
        return throwBeforeYield(transientError("connection_error"));
      },
    };
    const model = augmentModel(adapter, [
      withRetry({ maxAttempts: 2, connectionInitialDelayMs: 0 }),
    ]);

    await expect(collect(model.stream([]))).rejects.toThrow("transient");
    expect(calls).toBe(2);
  });

  it("cancels an unbounded connection wait through the model signal", async () => {
    const controller = new AbortController();
    const notices: string[] = [];
    const adapter: ModelAdapter = {
      id: "test-model",
      stream: () => throwBeforeYield(transientError("connection_error")),
    };
    const model = augmentModel(adapter, [
      withRetry({
        connectionRetry: "unbounded",
        connectionInitialDelayMs: 60_000,
        onRetry: (notice) => notices.push(notice.type),
      }),
    ]);
    const pending = collect(model.stream([], { signal: controller.signal }));
    controller.abort(new Error("stop reconnecting"));

    await expect(pending).rejects.toThrow("stop reconnecting");
    expect(notices).toEqual(["retry_wait"]);
  });

  it("retries bounded request timeouts", async () => {
    let calls = 0;
    const adapter: ModelAdapter = {
      id: "test-model",
      stream: async function* () {
        calls += 1;
        if (calls === 1) throw transientError("timeout");
        yield { type: "text", content: "ok" };
      },
    };
    const model = augmentModel(adapter, [withRetry({ maxAttempts: 2, initialDelayMs: 0 })]);

    await expect(collect(model.stream([]))).resolves.toEqual([{ type: "text", content: "ok" }]);
    expect(calls).toBe(2);
  });

  it("does not retry non-retryable ModelCallError", async () => {
    let calls = 0;
    const adapter: ModelAdapter = {
      id: "test-model",
      stream() {
        calls += 1;
        return throwBeforeYield(
          new ModelCallError("bad request", {
            modelId: "test-model",
            code: "unknown",
          }),
        );
      },
    };

    const model = augmentModel(adapter, [withRetry({ maxAttempts: 3, initialDelayMs: 0 })]);

    await expect(collect(model.stream([]))).rejects.toThrow("bad request");
    expect(calls).toBe(1);
  });

  it("does not retry after any stream event has been yielded", async () => {
    let calls = 0;
    const adapter: ModelAdapter = {
      id: "test-model",
      stream: async function* () {
        calls += 1;
        yield { type: "text", content: "partial" };
        throw transientError("server_error");
      },
    };

    const model = augmentModel(adapter, [withRetry({ maxAttempts: 3, initialDelayMs: 0 })]);
    const stream = model.stream([]);

    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { type: "text", content: "partial" },
    });
    await expect(stream.next()).rejects.toThrow("transient");
    expect(calls).toBe(1);
  });

  it("retries local rate limit errors and honors maxAttempts", async () => {
    let calls = 0;
    const adapter: ModelAdapter = {
      id: "test-model",
      stream() {
        calls += 1;
        const error = new Error("local rate limit") as Error & {
          code: number;
          retryAfterMs: number;
        };
        error.name = "RateLimitExceededError";
        error.code = 429;
        error.retryAfterMs = 0;
        return throwBeforeYield(error);
      },
    };

    const model = augmentModel(adapter, [withRetry({ maxAttempts: 2, initialDelayMs: 10 })]);

    await expect(collect(model.stream([]))).rejects.toThrow("local rate limit");
    expect(calls).toBe(2);
  });

  it("rejects invalid jitter ratios", () => {
    expect(() => withRetry({ jitterRatio: -0.1 })).toThrow("invalid backoff options");
    expect(() => withRetry({ jitterRatio: 1.1 })).toThrow("invalid backoff options");
  });
});
