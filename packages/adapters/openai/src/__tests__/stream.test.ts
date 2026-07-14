/**
 * Stream tests: OpenAI adapter under Rejelly framework (real E2E).
 * Dynamically register matrix scenarios by provider/model/env var.
 */

import { runFrameworkStreamTests } from "@rejelly/test-utils";
import { describe } from "vitest";
import { createOpenAIAdapter } from "../index";
import { streamTestMatrix } from "./stream.matrix";

streamTestMatrix.forEach((config) => {
  const apiKey = process.env[config.envVarKey];
  const runE2E = apiKey ? describe : describe.skip;

  runE2E(`E2E Test: ${config.provider} - ${config.modelId}`, () => {
    if (!apiKey) return;
    runFrameworkStreamTests(
      () =>
        createOpenAIAdapter({
          modelId: config.modelId,
          apiKey,
          baseURL: config.baseURL,
          provider: config.provider,
          schemaMode: config.capabilities.nativeSchema ? "json_schema" : "prompt",
        }),
      config.capabilities,
    );
  });
});
