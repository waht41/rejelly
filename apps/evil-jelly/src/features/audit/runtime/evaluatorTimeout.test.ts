import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditEvaluatorTimeoutError, evaluateWithTimeout } from "./evaluatorTimeout";

afterEach(() => {
  vi.useRealTimers();
});

describe("evaluateWithTimeout", () => {
  it("aborts and settles an evaluator that never resolves", async () => {
    vi.useFakeTimers();
    let evaluatorSignal: AbortSignal | undefined;
    const evaluation = evaluateWithTimeout((signal) => {
      evaluatorSignal = signal;
      return new Promise(() => undefined);
    }, 250);
    const rejected = expect(evaluation).rejects.toEqual(new AuditEvaluatorTimeoutError(250));

    await vi.advanceTimersByTimeAsync(250);

    await rejected;
    expect(evaluatorSignal?.aborted).toBe(true);
    expect(evaluatorSignal?.reason).toEqual(new AuditEvaluatorTimeoutError(250));
  });

  it("forwards parent cancellation through the evaluator signal", async () => {
    const parent = new AbortController();
    let evaluatorSignal: AbortSignal | undefined;
    const evaluation = evaluateWithTimeout(
      (signal) => {
        evaluatorSignal = signal;
        return new Promise(() => undefined);
      },
      10_000,
      parent.signal,
    );
    const reason = new Error("audit stopped");
    const rejected = expect(evaluation).rejects.toBe(reason);

    parent.abort(reason);

    await rejected;
    expect(evaluatorSignal?.aborted).toBe(true);
    expect(evaluatorSignal?.reason).toBe(reason);
  });

  it("returns a completed verdict without aborting its signal", async () => {
    let evaluatorSignal: AbortSignal | undefined;

    await expect(
      evaluateWithTimeout(async (signal) => {
        evaluatorSignal = signal;
        return "done";
      }, 10_000),
    ).resolves.toBe("done");
    expect(evaluatorSignal?.aborted).toBe(false);
  });

  it("shares one parent abort listener across concurrent evaluators and removes it afterward", async () => {
    const parent = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const evaluations = Array.from({ length: 12 }, () =>
      evaluateWithTimeout(
        async () => {
          await gate;
          return "done";
        },
        10_000,
        parent.signal,
      ),
    );

    expect(getEventListeners(parent.signal, "abort")).toHaveLength(1);

    release();
    await expect(Promise.all(evaluations)).resolves.toEqual(Array(12).fill("done"));
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
  });
});
