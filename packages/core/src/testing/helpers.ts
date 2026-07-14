/**
 * Shared test utilities for Rejelly tests
 *
 * NOTE: No test framework dependencies (vitest/jest) — this module is shipped to users.
 */

import { z } from "zod";
import type { AgentHandler } from "../core/context/agent";
import type { RebornSignal } from "../core/context/lifecycle";
import { createAgent } from "../core/engine/agent";
import { equipSystem } from "../core/facade/equip/equip";
import { equipMemory } from "../core/facade/equip/memory";
import { promptAgent } from "../core/policy/prompt-schema";
import { createMockModel } from "./mock-model";
import type { TestAgentConfig } from "./type";

export { createMockModel } from "./mock-model";
export type { MockModel, MockToolCall } from "./type";

/**
 * Create a test agent with configurable behavior
 *
 * @param config - Test agent configuration
 * @returns Agent instance
 *
 * @example
 * // Simple agent with default behavior
 * const agent = createTestAgent();
 *
 * @example
 * // Agent with preset memory and system prompt
 * const agent = createTestAgent({
 *   memory: { count: 0 },
 *   systemPrompt: 'You are helpful',
 * });
 *
 * @example
 * // Agent with custom behavior
 * const agent = createTestAgent({
 *   behavior: async (props) => {
 *     equipSystem('Custom logic');
 *     return await promptAgent(schemas.simple);
 *   },
 * });
 */
export function createTestAgent<P = any, R = any>(config: TestAgentConfig<P, R> = {}) {
  // Generate default ID if not provided
  const agentId = config.id || `test_agent_${Math.random().toString(36).slice(2, 7)}`;

  // Default model (create new mock if not provided)
  const mock = createMockModel();
  const model = config.model || mock.adapter;

  const handler = async (props?: P) => {
    // A. Equip Phase
    if (config.systemPrompt) {
      equipSystem(config.systemPrompt);
    }

    // Automatically equip memory
    if (config.memory) {
      for (const [key, val] of Object.entries(config.memory)) {
        equipMemory(key, val);
      }
    }

    // B. Custom hooks
    if (config.beforePrompt) {
      await config.beforePrompt();
    }

    // C. Execution Phase
    if (typeof config.behavior === "function") {
      return (await config.behavior(props as P)) as R | RebornSignal<P>;
    }

    if (config.behavior === "echo") {
      return props as unknown as R;
    }

    // Default behavior: Simple Prompt
    // If child agents are configured, call them here
    if (config.children) {
      const results: Record<string, any> = {};
      for (const [key, child] of Object.entries(config.children)) {
        results[key] = await child(props);
      }
      return results as unknown as R;
    }

    // Most basic call
    return (await promptAgent(schemas.simple)) as unknown as R;
  };

  return createAgent({
    id: agentId,
    model: model,
    handler: handler as AgentHandler<P, R>,
  });
}

/**
 * Common test schemas
 */
export const schemas = {
  simple: z.object({ result: z.string() }),
  user: z.object({ name: z.string(), age: z.number() }),
  action: z.object({ action: z.string(), data: z.any().optional() }),
  done: z.object({ done: z.boolean() }),
};

/**
 * Capture console warnings (zero-dependency, works with any test framework)
 */
export function captureWarnings() {
  const warnings: string[] = [];
  const originalWarn = console.warn;

  console.warn = (...args: any[]) => {
    warnings.push(args.map(String).join(" "));
  };

  return {
    warnings,
    restore: () => {
      console.warn = originalWarn;
    },
  };
}
