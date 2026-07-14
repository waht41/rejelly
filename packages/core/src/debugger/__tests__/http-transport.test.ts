import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpSender } from "../http-transport";

describe("createHttpSender", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("retries retryable HTTP responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 500 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const send = createHttpSender<number>(
      {
        endpoint: "http://localhost/retry",
        headers: { "Content-Type": "application/json" },
        maxRetries: 1,
        retryBaseDelayMs: 0,
        retryJitterMs: 0,
      },
      (batch) => JSON.stringify(batch),
    );

    await send([1]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("drops non-retryable client errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const send = createHttpSender<number>(
      {
        endpoint: "http://localhost/client-error",
        headers: { "Content-Type": "application/json" },
        maxRetries: 3,
        retryBaseDelayMs: 0,
        retryJitterMs: 0,
      },
      (batch) => JSON.stringify(batch),
    );

    await send([1]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries network errors before opening the circuit", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    const send = createHttpSender<number>(
      {
        endpoint: "http://localhost/network-retry",
        headers: { "Content-Type": "application/json" },
        maxRetries: 2,
        retryBaseDelayMs: 0,
        retryJitterMs: 0,
        circuitBreakerMs: 30_000,
      },
      (batch) => JSON.stringify(batch),
    );

    // First send exhausts all attempts (3) then opens the circuit.
    await send([1]);
    // Second send is dropped by the open circuit without touching fetch.
    await send([2]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("recovers from a transient network error without opening the circuit", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const send = createHttpSender<number>(
      {
        endpoint: "http://localhost/network-transient",
        headers: { "Content-Type": "application/json" },
        maxRetries: 1,
        retryBaseDelayMs: 0,
        retryJitterMs: 0,
        circuitBreakerMs: 30_000,
      },
      (batch) => JSON.stringify(batch),
    );

    // Attempt 0 fails, attempt 1 succeeds — circuit stays closed.
    await send([1]);
    // Next batch still reaches fetch (circuit was never opened).
    await send([2]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("logs the underlying error cause when the endpoint is unreachable", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5789"), {
      code: "ECONNREFUSED",
    });
    const fetchMock = vi
      .fn()
      .mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause }));
    vi.stubGlobal("fetch", fetchMock);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const send = createHttpSender<number>(
      {
        endpoint: "http://localhost/network-cause",
        headers: { "Content-Type": "application/json" },
        maxRetries: 0,
        retryBaseDelayMs: 0,
        retryJitterMs: 0,
        circuitBreakerMs: 30_000,
      },
      (batch) => JSON.stringify(batch),
    );

    await send([1]);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain("ECONNREFUSED");
  });
});
