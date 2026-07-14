/**
 * Trace & Inspection Utilities
 *
 * Provides utilities for capturing and inspecting agent execution traces
 */

import type { AgentContext } from "../core/context/type";
import { EVENTS, type TraceEvent } from "../core/domain/events";
import { getGlobalEventBus } from "../core/observability/event-bus";
import { runInTestContext } from "./test-context";
import type { AgentTrace, CaptureEventOptions } from "./type";

export type { AgentTrace, CaptureEventOptions } from "./type";

/**
 * Run agent and capture complete lifecycle information
 *
 * Captures all events emitted during agent execution, including:
 * - agent:start, agent:end, agent:reborn
 * - generation:start, generation:end
 * - turn:start, turn:end
 * - tool execution events
 * - and more
 *
 * @param agentRunner - Function that runs the agent (receives context)
 * @param options - Capture options
 * @returns Complete trace with result, events, memory, and reborn count
 *
 * @example
 * const { events, rebornCount, finalMemory } = await runAndCaptureEvent(
 *   (ctx) => MyAgent({ query: 'test' })
 * )
 * expect(rebornCount).toBe(3)
 * expect(finalMemory.history).toHaveLength(3)
 */
export async function runAndCaptureEvent<T>(
  agentRunner: (ctx: AgentContext) => Promise<T>,
  options: CaptureEventOptions = {},
): Promise<AgentTrace> {
  const { filter, eventBus: customEventBus } = options;

  // Create or use provided event bus
  const eventBus = customEventBus || getGlobalEventBus();
  const events: TraceEvent[] = [];

  // Subscribe to events
  const unsubscribe = eventBus.subscribeMany(
    filter || Object.values(EVENTS),
    (event: TraceEvent) => {
      events.push(event);
    },
  );

  try {
    // Run agent in test context with custom event bus
    const finalMemory: Record<string, any> = {};
    const result = await runInTestContext(
      async (ctx) => {
        // Override context's event bus if custom one provided
        if (customEventBus) {
          ctx.eventBus = customEventBus;
        }
        const agentResult = await agentRunner(ctx);
        // Extract final memory from context
        for (const [key, value] of ctx.memory.entries()) {
          finalMemory[key] = value;
        }
        return agentResult;
      },
      {
        eventBus: eventBus,
      },
    );

    // Count reborn events
    const rebornEvents = events.filter((e) => e.type === EVENTS.AGENT_REBORN);
    const rebornCount = rebornEvents.length;

    return {
      result,
      events,
      finalMemory,
      rebornCount,
      filterByType: (type: string) => events.filter((e) => e.type === type),
    };
  } finally {
    unsubscribe();
  }
}
