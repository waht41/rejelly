/**
 * Adapter compliance tests (E2E). Dynamically register matrix scenarios.
 */

import { runStandardAdapterTests } from "@rejelly/test-utils";
import { describe } from "vitest";
import { createGeminiAdapter } from "../index";
import { streamTestMatrix } from "./stream.matrix";

streamTestMatrix.forEach((config) => {
  const apiKey = process.env[config.envVarKey];
  const runE2E = apiKey ? describe : describe.skip;

  runE2E(`Compliance Test: ${config.provider} - ${config.modelId}`, () => {
    if (!apiKey) return;
    runStandardAdapterTests(
      `${config.provider}-${config.modelId}`,
      () =>
        createGeminiAdapter({
          modelId: config.modelId,
          apiKey,
        }),
      config.capabilities,
    );
  });
});
