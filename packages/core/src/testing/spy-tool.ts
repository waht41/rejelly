/**
 * Spy Tool Utilities
 *
 * Provides utilities for creating spy tools to monitor tool execution.
 *
 * NOTE: No test framework dependencies (vitest/jest) — this module is shipped to users.
 */

import { z } from "zod";
import type { ToolDefinition } from "../core/domain/tool";
import type { SpyToolResult, StandaloneSpy } from "./type";

export type { SpyToolResult, StandaloneSpy } from "./type";

/**
 * Create a standalone spy wrapper around an implementation function
 */
function createSpy<TArgs extends any[], TReturn>(
  impl: (...args: TArgs) => TReturn,
): StandaloneSpy<TArgs, TReturn> {
  const calls: TArgs[] = [];

  const wrapper = ((...args: TArgs): TReturn => {
    calls.push(args);
    return impl(...args);
  }) as StandaloneSpy<TArgs, TReturn>;

  wrapper.calls = calls;
  Object.defineProperty(wrapper, "callCount", {
    get: () => calls.length,
    enumerable: true,
  });
  wrapper.reset = () => {
    calls.length = 0;
  };

  return wrapper;
}

// ============ Spy Tool ============

/**
 * Create a spy tool with monitoring capability
 *
 * The tool can be used to verify:
 * - Whether the tool was called
 * - How many times it was called
 * - What arguments were passed
 * - Whether middleware modified the arguments
 *
 * @param name - Tool name
 * @param impl - Optional implementation (default returns mock result)
 * @param description - Tool description
 * @param parameters - Zod schema for parameters (default: passthrough)
 * @returns Tool definition and spy function
 *
 * @example
 * const { tool, spy } = createSpyTool('search')
 *
 * await runInTestContext((ctx) => {
 *   equipTool(tool)
 *   return MyAgent({ q: 'test' })
 * })
 *
 * // Works with any assertion library
 * expect(spy.callCount).toBe(1)
 * expect(spy.calls[0][0]).toEqual({ q: 'test' })
 */
export function createSpyTool(
  name: string,
  impl?: (args: any) => any,
  description?: string,
  parameters?: z.ZodTypeAny,
): SpyToolResult {
  const spy = createSpy(impl || (async () => `Result from ${name}`));

  const tool: ToolDefinition = {
    name,
    description: description || `Mock tool for ${name}`,
    parameters: parameters || z.object({}).passthrough(),
    handler: spy,
  };

  return { tool, spy };
}
