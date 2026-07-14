/**
 * Scenario Builder DSL
 *
 * Provides a fluent DSL for building test scenarios with sequential mocking
 */

import type { AgentFunction } from "../core/context/agent";
import { deepEqual } from "../utils/object";
import { createMockModel } from "./mock-model";
import {
  expectInstructionContains as _expectInstructionContains,
  expectSystemContains as _expectSystemContains,
} from "./prompt-assertions";
import { expectToolCalled as _expectToolCalled } from "./tool-assertions";
import type {
  MockResponse,
  MockSequenceStep,
  MockToolCall,
  ScenarioBuilder,
  ScenarioState,
} from "./type";

export type { ScenarioBuilder } from "./type";

/**
 * Create a scenario builder for testing agent behavior
 *
 * Provides a fluent DSL to describe conversation scripts:
 * - Set input props
 * - Configure sequential LLM responses
 * - Assert tool calls
 * - Run and verify
 *
 * @param agent - Agent function to test
 * @returns Scenario builder chain
 *
 * @example
 * await createScenario(SearchAgent)
 *   .withInput({ topic: 'Rejelly' })
 *   .nextTurn({ action: 'search', query: 'Rejelly docs' })
 *   .expectToolCall('google_search', { q: 'Rejelly docs' })
 *   .nextTurn({ action: 'answer', text: 'Found it' })
 *   .run()
 */
export function createScenario<P = any, R = any>(agent: AgentFunction<P, R>): ScenarioBuilder {
  const state: ScenarioState = {
    mock: createMockModel(),
    inputs: {},
    responses: [],
    toolCalls: [],
    expectations: [],
    promptAssertions: [],
  };

  const builder: ScenarioBuilder = {
    withInput(props: any) {
      state.inputs = props;
      return builder;
    },

    nextTurn(response: MockResponse) {
      const step: MockSequenceStep =
        typeof response === "string"
          ? { type: "text", content: response }
          : { type: "json", content: response };
      state.responses.push(step);
      return builder;
    },

    nextTurnWithTools(toolCalls: MockToolCall[]) {
      state.toolCalls.push(toolCalls);
      // For tool calls, we need to use when() with toolName condition
      // This is a simplified version - in practice, you might need more complex logic
      return builder;
    },

    expectToolCall(toolName: string, args?: any) {
      state.expectations.push({ toolName, args });
      return builder;
    },

    expectSystemContains(expected: string | RegExp) {
      state.promptAssertions.push({ type: "system", expected });
      return builder;
    },

    expectInstructionContains(expected: string | RegExp) {
      state.promptAssertions.push({ type: "instruction", expected });
      return builder;
    },

    expectReturns(expected: any) {
      state.expectedReturn = { value: expected };
      return builder;
    },

    async run() {
      // Configure mock with sequence
      if (state.responses.length > 0) {
        state.mock.sequence(state.responses);
      }

      // Fork agent with mock model to intercept LLM calls
      const forkedAgent = agent.fork({ model: state.mock.adapter });

      // Run agent
      const result = await forkedAgent(state.inputs);

      const totalTurns = state.mock.calls.count();

      // Verify prompt assertions
      for (const assertion of state.promptAssertions) {
        try {
          if (assertion.type === "system") {
            _expectSystemContains(state.mock, assertion.expected);
          } else {
            _expectInstructionContains(state.mock, assertion.expected);
          }
        } catch (err) {
          throw new Error(
            `Scenario assertion failed (${totalTurns} turn(s) completed): ${(err as Error).message}`,
          );
        }
      }

      // Verify tool call expectations
      for (const expectation of state.expectations) {
        try {
          _expectToolCalled(state.mock, expectation.toolName, expectation.args);
        } catch (err) {
          throw new Error(
            `Scenario assertion failed at Turn ${totalTurns}: ${(err as Error).message}`,
          );
        }
      }

      // Verify return value
      if (state.expectedReturn) {
        if (!deepEqual(result, state.expectedReturn.value)) {
          throw new Error(
            `Scenario assertion failed at Turn ${totalTurns}: expected agent to return ${JSON.stringify(state.expectedReturn.value)}, but got ${JSON.stringify(result)}`,
          );
        }
      }

      return result;
    },
  };

  return builder;
}
