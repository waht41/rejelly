import { beforeEach, describe, expect, it, vi } from "vitest";

const createOpenAIAdapter = vi.hoisted(() =>
  vi.fn((_config: unknown) => ({
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
    OPENAI_API_PROTOCOL: "chat_completions",
    OPENAI_REASONING_EFFORT: "",
    OPENAI_RETRY_MAX_ATTEMPTS: 3,
  },
}));

import { env } from "../../shared/configuration/env";
import { createOpenAIModelFromEnv } from "./createModelFromEnv";

describe("createOpenAIModelFromEnv", () => {
  beforeEach(() => {
    createOpenAIAdapter.mockClear();
    const mockedEnv = env as unknown as Record<string, unknown>;
    mockedEnv.OPENAI_API_PROTOCOL = "chat_completions";
    mockedEnv.OPENAI_REASONING_EFFORT = "";
  });

  it("keeps Chat Completions explicit and disables nested SDK retries", () => {
    createOpenAIModelFromEnv();

    expect(createOpenAIAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        api: "chat_completions",
        requestOption: { maxRetries: 0 },
      }),
    );
  });

  it("maps reasoning effort to Responses parameters", () => {
    const mockedEnv = env as unknown as Record<string, unknown>;
    mockedEnv.OPENAI_API_PROTOCOL = "responses";
    mockedEnv.OPENAI_REASONING_EFFORT = "high";

    createOpenAIModelFromEnv();

    expect(createOpenAIAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        api: "responses",
        responseParams: { reasoning: { effort: "high" } },
      }),
    );
    expect(createOpenAIAdapter.mock.calls[0]?.[0]).not.toHaveProperty("chatCompletionParams");
  });
});
