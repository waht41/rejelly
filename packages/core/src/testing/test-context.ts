/**
 * Test Context Utilities
 *
 * Provides utilities for creating test contexts
 */

import { runInContext } from "../core/context/accessor";
import { type CreateAgentContextOptions, createAgentContext } from "../core/context/factory";
import type { AgentContext } from "../core/context/type";
import { createMockModel } from "./mock-model";

/**
 * Create a test context with minimal configuration
 *
 * @param options - Optional context options
 * @returns Test context
 */
export function createTestContext(options?: Partial<CreateAgentContextOptions>): AgentContext {
  const mock = createMockModel();
  const { ctx: context } = createAgentContext({
    model: mock.adapter,
    agentId: "test-agent",
    ...options,
  });
  return context;
}

/**
 * Run a function in a test context
 *
 * @param callback - Function to run in context (context parameter is optional)
 * @param options - Optional context options
 * @returns Result of callback
 */
export async function runInTestContext<T>(
  callback: ((context: AgentContext) => T | Promise<T>) | (() => T | Promise<T>),
  options?: Partial<CreateAgentContextOptions>,
): Promise<T> {
  const context = createTestContext(options);
  return await runInContext(context, () => {
    // Check if callback accepts context parameter
    if (callback.length > 0) {
      return (callback as (context: AgentContext) => T | Promise<T>)(context);
    } else {
      return (callback as () => T | Promise<T>)();
    }
  });
}
