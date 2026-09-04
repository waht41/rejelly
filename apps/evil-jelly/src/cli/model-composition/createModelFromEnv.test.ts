import { beforeEach, describe, expect, it, vi } from "vitest";

const createOpenAIAdapter = vi.hoisted(() =>
  vi.fn(() => ({
    id: "test-model",
    async *stream() {},
  })),
);

vi.mock("@rejelly/adapter-openai", () => ({ createOpenAIAdapter }));
vi.mock("../../shared/configuration/env", () => ({
  env: {
    OPENAI_API_KEY: "test-key",
    OPENAI_MODEL_ID: "test-model",
    OPENAI_BASE_URL: "https://gateway.test/v1",
    OPENAI_PROVIDER: "openai",
    OPENAI_REASONING_EFFORT: "",
    OPENAI_RETRY_MAX_ATTEMPTS: 3,
  },
}));

import { createOpenAIModelFromEnv } from "./createModelFromEnv";

describe("createOpenAIModelFromEnv", () => {
  beforeEach(() => {
    createOpenAIAdapter.mockClear();
  });

  it("disables SDK retries so the Evil middleware owns the retry budget", () => {
    createOpenAIModelFromEnv();

    expect(createOpenAIAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ requestOption: { maxRetries: 0 } }),
    );
  });
});
