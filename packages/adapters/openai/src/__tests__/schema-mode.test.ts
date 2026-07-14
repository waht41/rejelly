/**
 * Unit tests (mocked SDK, no network) locking the `schemaMode` request-building
 * matrix: which `response_format` is sent and whether the schema is injected into
 * the prompt. Guards the DeepSeek json_object path that E2E tests can't cover
 * without a live key.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenAIAdapter } from "../adapter";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("openai", () => ({
  default: class {
    baseURL = "https://mock.test/v1";
    chat = { completions: { create: mocks.create } };
  },
  APIError: class APIError extends Error {},
}));

async function* singleStopChunk() {
  yield { choices: [{ delta: {}, finish_reason: "stop" }] };
}

const SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
} as const;

type CapturedParams = {
  response_format?: { type: string };
  messages: Array<{ role: string; content: string }>;
};

async function runStream(
  schemaMode: "prompt" | "json_object" | "json_schema" | undefined,
  options: { withSchema: boolean },
): Promise<CapturedParams> {
  const adapter = createOpenAIAdapter({
    modelId: "test-model",
    apiKey: "test-key",
    baseURL: "https://mock.test/v1",
    ...(schemaMode ? { schemaMode } : {}),
    calculateCost: () => ({}),
  });

  for await (const _ of adapter.stream([{ role: "user", content: "hi" }], {
    ...(options.withSchema ? { schema: SCHEMA as Record<string, unknown> } : {}),
  })) {
    // drain
  }

  return mocks.create.mock.calls[0][0] as CapturedParams;
}

function systemPromptOf(params: CapturedParams): string {
  return params.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
}

describe("OpenAI adapter schemaMode request building", () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.create.mockImplementation(() => singleStopChunk());
  });

  it("json_object: sends response_format json_object AND injects schema into the prompt", async () => {
    const params = await runStream("json_object", { withSchema: true });

    expect(params.response_format).toEqual({ type: "json_object" });
    // json_object only guarantees valid JSON, not field conformance — schema must
    // still reach the model via the prompt.
    expect(systemPromptOf(params)).toContain("answer");
  });

  it("json_schema: sends strict json_schema and does NOT inject the schema into the prompt", async () => {
    const params = await runStream("json_schema", { withSchema: true });

    expect(params.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "response", schema: SCHEMA, strict: true },
    });
    expect(systemPromptOf(params)).not.toContain("answer");
  });

  it("prompt (default): sends no response_format and injects the schema into the prompt", async () => {
    const params = await runStream(undefined, { withSchema: true });

    expect(params.response_format).toBeUndefined();
    expect(systemPromptOf(params)).toContain("answer");
  });

  it("no schema: sends no response_format regardless of mode", async () => {
    const params = await runStream("json_object", { withSchema: false });

    expect(params.response_format).toBeUndefined();
  });
});
