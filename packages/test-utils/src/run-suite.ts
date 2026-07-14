/// <reference types="vitest/globals" />

import type { ModelAdapter } from "@rejelly/core";
import type { CapabilityName, TestCapabilities } from "./capabilities";

export interface TestScenario {
  name: string;
  capabilitiesRequired: CapabilityName[];
  handler: (adapter: ModelAdapter) => Promise<void>;
}

export function runScenarioSuite(
  suiteName: string,
  scenarios: TestScenario[],
  getAdapter: () => ModelAdapter,
  capabilities: TestCapabilities,
): void {
  describe(suiteName, () => {
    scenarios.forEach((scenario) => {
      const missingCaps = scenario.capabilitiesRequired.filter(
        (capability) => !capabilities[capability],
      );
      const isSupported = missingCaps.length === 0;
      const testRunner = isSupported ? it : it.skip;
      const testName = isSupported
        ? scenario.name
        : `${scenario.name} (skipped: missing capabilities: ${missingCaps.join(", ")})`;

      testRunner(testName, async () => {
        const adapter = getAdapter();
        await scenario.handler(adapter);
      });
    });
  });
}
