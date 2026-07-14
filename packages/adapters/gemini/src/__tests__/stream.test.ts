/**
 * Stream tests: Gemini adapter under Rejelly framework (real E2E).
 * Dynamically register matrix scenarios by provider/model/env var.
 */

import { runFrameworkStreamTests } from "@rejelly/test-utils";
import { describe } from "vitest";
import { createGeminiAdapter } from "../index";
import { streamTestMatrix } from "./stream.matrix";

streamTestMatrix.forEach((config) => {
  const apiKey = process.env[config.envVarKey];
  const runE2E = apiKey ? describe : describe.skip;

  runE2E(`E2E Test: ${config.provider} - ${config.modelId}`, () => {
    if (!apiKey) return;
    runFrameworkStreamTests(
      () =>
        createGeminiAdapter({
          modelId: config.modelId,
          apiKey,
        }),
      config.capabilities,
    );
  });
});
