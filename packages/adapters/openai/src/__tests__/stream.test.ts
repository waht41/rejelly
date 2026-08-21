/**
 * Stream tests: OpenAI adapter under Rejelly framework (real E2E).
 * Dynamically register matrix scenarios by provider/model/env var.
 */

import { runFrameworkStreamTests } from "@rejelly/test-utils";
import { describe } from "vitest";
import { createOpenAIAdapter } from "../index";
import { resolveOpenAIStreamTestConfig, streamTestMatrix } from "./stream.matrix";

streamTestMatrix.forEach((config) => {
  const resolved = resolveOpenAIStreamTestConfig(config);
  const runE2E = resolved ? describe : describe.skip;

  runE2E(`E2E Test: ${config.envId}`, () => {
    if (!resolved) return;
    runFrameworkStreamTests(
      () =>
        createOpenAIAdapter({
          modelId: resolved.modelId,
          apiKey: resolved.apiKey,
          baseURL: resolved.baseURL,
          provider: resolved.provider,
          schemaMode: config.capabilities.nativeSchema ? "json_schema" : "prompt",
        }),
      config.capabilities,
    );
  });
});
