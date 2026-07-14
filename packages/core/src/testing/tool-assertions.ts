/**
 * Tool Assertions
 *
 * Utilities for asserting tool calls recorded by MockModel.
 * Works by inspecting tool result messages in CallRecord.
 *
 * NOTE: No test framework dependencies (vitest/jest) — this module is shipped to users.
 */

import { deepEqual } from "../utils/object";
import type { CallRecord, MockModel } from "./type";

/**
 * Collect all tool names that actually appeared in recorded calls
 */
function collectCalledToolNames(calls: CallRecord[]): string[] {
  const names = new Set<string>();
  for (const record of calls) {
    for (const m of record.messages) {
      if (m.role === "tool" && m.name) {
        names.add(m.name);
      }
    }
  }
  return [...names];
}

/**
 * Parse tool call arguments from assistant messages for a specific tool
 */
function findToolCallArgs(calls: CallRecord[], toolName: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  for (const record of calls) {
    for (const m of record.messages) {
      if (m.role === "assistant" && m.tool_calls) {
        for (const tc of m.tool_calls) {
          if (tc.name === toolName) {
            try {
              results.push(JSON.parse(tc.arguments));
            } catch {
              results.push({ _raw: tc.arguments });
            }
          }
        }
      }
    }
  }
  return results;
}

/**
 * Assert that a tool was called during agent execution.
 *
 * Scans all mock call records for `role: 'tool'` messages matching the given tool name.
 * Optionally verifies that the tool was called with expected arguments (deep equality).
 *
 * @param mock - MockModel instance that recorded calls
 * @param toolName - Expected tool name
 * @param args - Optional expected arguments (deep equality check)
 *
 * @example
 * const mock = createMockModel()
 * mock.when({ input: 'search' }).thenCallTools([
 *   { id: '1', name: 'google_search', arguments: { q: 'Rejelly' } }
 * ])
 * const forked = MyAgent.fork({ model: mock.adapter })
 * await runWith(async () => await forked({ query: 'search' }))
 * expectToolCalled(mock, 'google_search')
 * expectToolCalled(mock, 'google_search', { q: 'Rejelly' })
 */
export function expectToolCalled(mock: MockModel, toolName: string, args?: unknown): void {
  const allCalls = mock.calls.all();
  if (allCalls.length === 0) {
    throw new Error(
      "MockModel has no recorded calls. Did you forget to run the agent with mock.adapter?",
    );
  }

  const calledTools = collectCalledToolNames(allCalls);

  const found = calledTools.includes(toolName);
  if (!found) {
    const actualList =
      calledTools.length > 0 ? calledTools.map((n) => `'${n}'`).join(", ") : "(none)";
    throw new Error(
      `[expectToolCalled] Expected tool '${toolName}' to be called, but it was never invoked.\n` +
        `  Tools actually called: ${actualList}`,
    );
  }

  if (args !== undefined) {
    const actualArgsList = findToolCallArgs(allCalls, toolName);
    const matched = actualArgsList.some((actual) => deepEqual(actual, args));
    if (!matched) {
      const actualStr =
        actualArgsList.length > 0
          ? actualArgsList.map((a) => JSON.stringify(a)).join(", ")
          : "(no arguments captured)";
      throw new Error(
        `[expectToolCalled] Tool '${toolName}' was called, but not with expected arguments.\n` +
          `  Expected: ${JSON.stringify(args)}\n` +
          `  Actual calls: ${actualStr}`,
      );
    }
  }
}
