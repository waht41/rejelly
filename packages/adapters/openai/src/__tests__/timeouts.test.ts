import type { StreamEvent } from "@rejelly/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenAIAdapter } from "../adapter";

type Protocol = "chat_completions" | "responses";

/** Exercise the real SDK's header timer and SSE parser without external requests. */
function upstream(api: Protocol, headerDelayMs = 0) {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  let signal: AbortSignal | undefined;
  const encoder = new TextEncoder();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        body = controller;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  const fetch = vi.fn((_url: unknown, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(response), headerDelayMs);
      const onAbort = () => {
        clearTimeout(timer);
        const error = new DOMException("Aborted", "AbortError");
        body.error(error);
        reject(error);
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  });
  vi.stubGlobal("fetch", fetch);

  const write = (data: unknown) => {
    body.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
    id: "chat_1",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });

  return {
    signal: () => signal,
    metadata() {
      write(
        api === "responses"
          ? { type: "response.in_progress", response: { id: "resp_1" }, sequence_number: 1 }
          : chunk({ role: "assistant" }),
      );
    },
    text() {
      write(
        api === "responses"
          ? { type: "response.output_text.delta", delta: "partial", sequence_number: 2 }
          : chunk({ content: "partial" }),
      );
    },
    finish() {
      if (api === "responses") {
        write({
          type: "response.completed",
          response: { id: "resp_1", status: "completed", output: [], usage: null },
          sequence_number: 3,
        });
      } else {
        write(chunk({}, "stop"));
        body.enqueue(encoder.encode("data: [DONE]\n\n"));
      }
      body.close();
    },
  };
}

function adapter(api: Protocol, headerTimeoutMs: number, streamIdleTimeoutMs?: number) {
  return createOpenAIAdapter({
    api,
    modelId: "test-model",
    apiKey: "test-key",
    baseURL: "https://mock.test/v1",
    requestOption: { timeout: headerTimeoutMs, maxRetries: 0 },
    streamIdleTimeoutMs,
  });
}

async function collect(
  model: ReturnType<typeof createOpenAIAdapter>,
  seen: StreamEvent[] = [],
  signal?: AbortSignal,
) {
  for await (const event of model.stream([], { signal })) seen.push(event);
  return seen;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe.each<Protocol>(["chat_completions", "responses"])("%s timeout lifecycle", (api) => {
  it("allows queued response headers beyond 30 seconds without starting the idle timer", async () => {
    const server = upstream(api, 45_000);
    server.finish();
    const seen: StreamEvent[] = [];
    const result = collect(adapter(api, 300_000, 100), seen);

    await vi.advanceTimersByTimeAsync(44_999);
    expect(seen).toEqual([]);
    expect(server.signal()?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect((await result).at(-1)).toMatchObject({ type: "finish", finishReason: "stop" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a header timeout separately from stream inactivity", async () => {
    const server = upstream(api, 1_000);
    const result = collect(adapter(api, 100, 20)).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(99);
    expect(server.signal()?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(await result).toMatchObject({
      name: "ModelCallError",
      code: "timeout",
      message: expect.stringContaining("waiting for OpenAI response headers"),
    });
    expect(server.signal()?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resets idle waits on non-visible metadata and permits a long total generation", async () => {
    const server = upstream(api);
    const seen: StreamEvent[] = [];
    const result = collect(adapter(api, 50, 100), seen);
    await vi.advanceTimersByTimeAsync(0);

    for (let index = 0; index < 4; index += 1) {
      await vi.advanceTimersByTimeAsync(60);
      server.metadata();
      await vi.advanceTimersByTimeAsync(0);
      expect(server.signal()?.aborted).toBe(false);
      expect(seen).toEqual([]);
    }
    server.finish();

    expect((await result).at(-1)).toMatchObject({ type: "finish", finishReason: "stop" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("bounds a stalled stream (partial output: %s)", async (partial) => {
    const server = upstream(api);
    if (partial) server.text();
    const seen: StreamEvent[] = [];
    const result = collect(adapter(api, 50, 100), seen).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(partial ? [{ type: "text", content: "partial" }] : []);

    await vi.advanceTimersByTimeAsync(100);

    expect(await result).toMatchObject({
      name: "ModelCallError",
      code: "timeout",
      message: expect.stringContaining("stream idle timeout"),
    });
    expect(server.signal()?.aborted).toBe(true);
    expect(seen.some((event) => event.type === "finish")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a pending read promptly without misclassifying it as a timeout", async () => {
    const server = upstream(api);
    const controller = new AbortController();
    const result = collect(adapter(api, 50, 100), [], controller.signal).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort("Stopped by user");

    expect(await result).toMatchObject({ name: "AbortError" });
    expect(server.signal()?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not time out consumer backpressure and aborts on early consumer exit", async () => {
    const server = upstream(api);
    server.text();
    const stream = adapter(api, 50, 100).stream([]);
    const first = stream.next();
    await vi.advanceTimersByTimeAsync(0);
    expect(await first).toMatchObject({ done: false, value: { type: "text", content: "partial" } });

    await vi.advanceTimersByTimeAsync(200);
    expect(server.signal()?.aborted).toBe(false);
    await stream.return(undefined);

    expect(server.signal()?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
