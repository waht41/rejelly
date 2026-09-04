import { augmentModel, type ModelAdapter, ModelCallError, type StreamEvent } from "@rejelly/core";
import { describe, expect, it } from "vitest";
import { addRetryJitter, withRetry } from "./withRetry";

async function collect(stream: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function transientError(code: "rate_limit" | "server_error"): ModelCallError {
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
