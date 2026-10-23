import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), getWebConfig: vi.fn() }));
vi.mock("@rejelly/core", () => ({ getContextSignal: () => undefined }));
vi.mock("undici", () => ({ fetch: mocks.fetch, Agent: class Agent {} }));
vi.mock("./webConfig", () => ({ getWebConfig: mocks.getWebConfig }));

import { fetchText } from "./httpClient";

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.getWebConfig.mockReturnValue({
    timeoutMs: 1000,
    maxFetchBytes: 7,
    proxyUrl: null,
    userAgent: "test",
  });
});

function streamed(chunks: string[]) {
  const cancel = vi.fn().mockResolvedValue(undefined);
  const values = chunks.map((chunk) => Buffer.from(chunk));
  const read = vi.fn(async () =>
    values.length ? { done: false, value: values.shift()! } : { done: true, value: undefined },
  );
  mocks.fetch.mockResolvedValue({
    url: "https://example.test/final",
    status: 200,
    headers: new Headers({ "content-type": "text/html" }),
    body: { getReader: () => ({ read, cancel }) },
  });
  return { read, cancel };
}

describe("page-fetch byte limits", () => {
  it("slices an oversized chunk at the byte cap", async () => {
    const { cancel } = streamed(["12345", "67890123456789"]);
    expect(await fetchText("https://example.test")).toMatchObject({
      body: "1234567",
      truncated: true,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not call a source truncated when it ends exactly at the cap", async () => {
    const { cancel } = streamed(["123", "4567"]);
    expect(await fetchText("https://example.test")).toMatchObject({
      body: "1234567",
      truncated: false,
    });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("detects a following chunk after the cap", async () => {
    streamed(["1234567", "8"]);
    expect(await fetchText("https://example.test")).toMatchObject({
      body: "1234567",
      truncated: true,
    });
  });

  it("omits a split UTF-8 character rather than emitting a replacement character", async () => {
    streamed(["😀😀😀"]);
    const page = await fetchText("https://example.test");
    expect(page.body).toBe("😀");
    expect(page.truncated).toBe(true);
    expect(Buffer.byteLength(page.body, "utf8")).toBeLessThanOrEqual(7);
  });

  it("also enforces bytes rather than UTF-16 length without a response reader", async () => {
    mocks.fetch.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: null,
      text: async () => "界😀界",
    });
    expect(await fetchText("https://example.test")).toMatchObject({
      body: "界😀",
      truncated: true,
    });
  });
});
