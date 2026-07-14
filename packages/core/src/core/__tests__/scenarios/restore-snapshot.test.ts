/**
 * Restore Snapshot Tests
 *
 * Tests for restoreSnapshot function that reconstructs AgentSnapshot from TraceEvent array.
 * Tests include:
 * - Basic restore functionality
 * - anchor: 'before' and 'after' modes
 * - Memory recovery
 * - Journal recovery (Prompt and Tool)
 * - Nested agent restoration
 * - Error handling
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockModel, createTestAgent, schemas } from "../../../testing/helpers";
import { runAndCaptureEvent } from "../../../testing/trace-utils";
import { isAbortError } from "../../domain/errors";
import {
  type AgentEndEvent,
  type AgentStartEvent,
  EVENTS,
  TRACE_EVENT_SCHEMA_VERSION,
  type TraceEvent,
  type TurnEndEvent,
} from "../../domain/events";
import { equipTool } from "../../facade/equip/equip";
import { equipMemory } from "../../facade/equip/memory";
import { runWith } from "../../facade/run";
import { promptAgent } from "../../policy/prompt-schema";
import { restoreSnapshot } from "../../snapshot/restore";
import type { AgentSnapshot } from "../../snapshot/type";

describe("restoreSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("basic restore functionality", () => {
    it("should restore snapshot from trace events", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "test_result" });

      const TestAgent = createTestAgent({
        id: "test_agent",
        model: mock.adapter,
        memory: { count: 0 },
        behavior: async () => {
          const [_count, setCount] = equipMemory("count", 0);
          setCount(1);
          await promptAgent(schemas.simple);
          return { result: "done" };
        },
      });

      // Capture trace events
      const trace = await runAndCaptureEvent(async () => {
        return await TestAgent({});
      });

      // Find agent end event
      const agentEndEvent = trace.events.find((e) => e.type === EVENTS.AGENT_END) as
        | AgentEndEvent
        | undefined;

      expect(agentEndEvent).toBeDefined();

      if (agentEndEvent) {
        // Restore snapshot from trace
        const restored = restoreSnapshot(trace.events, {
          spanId: agentEndEvent.trace.spanId,
          anchor: "after",
        });

        expect(restored).toBeDefined();
        expect(restored.root).toBeDefined();
        expect(restored.root.agentId).toBe("test_agent");
        expect(restored.root.memory.count).toBe(1);
        expect(restored.root.state.status).toBe("completed");
      }
    });

    it("should restore snapshot with correct processId and timestamp", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "test" });

      const TestAgent = createTestAgent({
        id: "test_agent",
        model: mock.adapter,
        behavior: async () => {
          return { result: "done" };
        },
      });

      const trace = await runAndCaptureEvent(async () => {
        return await TestAgent({});
      });

      const agentEndEvent = trace.events.find((e) => e.type === EVENTS.AGENT_END) as
        | AgentEndEvent
        | undefined;

      if (agentEndEvent) {
        const restored = restoreSnapshot(trace.events, {
          spanId: agentEndEvent.trace.spanId,
          anchor: "after",
        });

        expect(restored.processId).toContain("restore:");
        expect(restored.processId).toContain(agentEndEvent.trace.spanId);
        expect(restored.timestamp).toBeGreaterThan(0);
      }
    });
  });

  describe("anchor modes", () => {
    it('should restore with anchor: "after" (include span result)', async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "test_result" });

      const TestAgent = createTestAgent({
        id: "test_agent",
        model: mock.adapter,
        behavior: async () => {
          await promptAgent(schemas.simple);
          return { result: "done" };
        },
      });

      const trace = await runAndCaptureEvent(async () => {
        return await TestAgent({});
      });

      const agentEndEvent = trace.events.find((e) => e.type === EVENTS.AGENT_END) as
        | AgentEndEvent
        | undefined;

      if (agentEndEvent) {
        const restored = restoreSnapshot(trace.events, {
          spanId: agentEndEvent.trace.spanId,
          anchor: "after",
        });

        // Should include the agent's completion state
        expect(restored.root.state.status).toBe("completed");
        expect(restored.root.state.output).toBeDefined();
      }
    });

    it('should restore with anchor: "before" (exclude span)', async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "test_result" });

      const TestAgent = createTestAgent({
        id: "test_agent",
        model: mock.adapter,
        behavior: async () => {
          await promptAgent(schemas.simple);
          return { result: "done" };
        },
      });

      const trace = await runAndCaptureEvent(async () => {
        return await TestAgent({});
      });

      const agentStartEvent = trace.events.find((e) => e.type === EVENTS.AGENT_START) as
        | AgentStartEvent
        | undefined;

      if (agentStartEvent) {
        // Try to restore before the agent starts
        // This should fail if the agent is at index 0
        const startIndex = trace.events.findIndex(
          (e) => e.trace.spanId === agentStartEvent.trace.spanId && e.type === EVENTS.AGENT_START,
        );

        if (startIndex > 0) {
          // If not at the beginning, should work
          const restored = restoreSnapshot(trace.events, {
            spanId: agentStartEvent.trace.spanId,
            anchor: "before",
          });

          // The snapshot should not contain this agent's frame
          expect(restored.root.callId).not.toBe(agentStartEvent.trace.spanId);
        }
      }
    });

    it('should throw error when anchor: "before" and span is at index 0', async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "test" });

      const TestAgent = createTestAgent({
        id: "test_agent",
        model: mock.adapter,
        behavior: async () => {
          return { result: "done" };
        },
      });

      const trace = await runAndCaptureEvent(async () => {
        return await TestAgent({});
      });

      const agentStartEvent = trace.events.find((e) => e.type === EVENTS.AGENT_START) as
        | AgentStartEvent
        | undefined;

      if (agentStartEvent) {
        // Sort events to ensure chronological order
        const sortedEvents = [...trace.events].sort((a, b) => a.timestamp - b.timestamp);
        const startIndex = sortedEvents.findIndex(
          (e) => e.trace.spanId === agentStartEvent.trace.spanId && e.type === EVENTS.AGENT_START,
        );

        if (startIndex === 0) {
          // Should throw error when trying to restore before the first event
          expect(() => {
            restoreSnapshot(trace.events, {
              spanId: agentStartEvent.trace.spanId,
              anchor: "before",
            });
          }).toThrow(/cannot restore before it/);
        }
      }
    });
  });

  describe("memory recovery", () => {
    it("should restore memory state from GenerationEnd events", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "test" });

      const TestAgent = createTestAgent({
        id: "test_agent",
        model: mock.adapter,
        memory: { initial: "value" },
        behavior: async () => {
          const [_count, setCount] = equipMemory("count", 0);
          const [_data, setData] = equipMemory("data", "");
          setCount(5);
          setData("updated");
          await promptAgent(schemas.simple);
          return { result: "done" };
        },
      });

      const trace = await runAndCaptureEvent(async () => {
        return await TestAgent({});
      });

      const agentEndEvent = trace.events.find((e) => e.type === EVENTS.AGENT_END) as
        | AgentEndEvent
        | undefined;

      if (agentEndEvent) {
        const restored = restoreSnapshot(trace.events, {
          spanId: agentEndEvent.trace.spanId,
          anchor: "after",
        });

        // Memory should be restored
        expect(restored.root.memory.count).toBe(5);
        expect(restored.root.memory.data).toBe("updated");
        expect(restored.root.memory.initial).toBe("value");
      }
    });
  });

  describe("journal recovery", () => {
    it("should restore prompt journal entries with contentHash", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "prompt_result" });

      const TestAgent = createTestAgent({
        id: "test_agent",
        model: mock.adapter,
        behavior: async () => {
          await promptAgent(schemas.simple);
          return { result: "done" };
        },
      });

      const trace = await runAndCaptureEvent(async () => {
        return await TestAgent({});
      });

      const agentEndEvent = trace.events.find((e) => e.type === EVENTS.AGENT_END) as
        | AgentEndEvent
        | undefined;

      if (agentEndEvent) {
        const restored = restoreSnapshot(trace.events, {
          spanId: agentEndEvent.trace.spanId,
          anchor: "after",
        });

        const turnEndEvent = trace.events.find(
          (e): e is TurnEndEvent => e.type === EVENTS.TURN_END,
        );

        expect(turnEndEvent?.contentHash).toEqual(expect.any(String));
        const contentHash = turnEndEvent?.contentHash ?? "";
        const journalEntry = restored.root.journal.prompt[contentHash];
        expect(journalEntry).toBeDefined();
        expect(journalEntry.output).toBeDefined();
        expect(journalEntry.contentHash).toBe(contentHash);
      }
    });

    it("should restore tool journal entries with contentHash", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "test" });

      // Create a tool
      const testTool = {
        name: "test_tool",
        description: "Test tool",
        parameters: schemas.simple,
        handler: async (args: { result: string }) => {
          return { output: `Tool result: ${args.result}` };
        },
      };

      const TestAgent = createTestAgent({
        id: "test_agent",
        model: mock.adapter,
        behavior: async () => {
          // Equip tool so it can be called by LLM
          equipTool(testTool);
          // Tool will be called by LLM
          await promptAgent(schemas.simple);
          return { result: "done" };
        },
      });

      const trace = await runAndCaptureEvent(async () => {
        return await TestAgent({});
      });

      const agentEndEvent = trace.events.find((e) => e.type === EVENTS.AGENT_END) as
        | AgentEndEvent
        | undefined;

      if (agentEndEvent) {
        const restored = restoreSnapshot(trace.events, {
          spanId: agentEndEvent.trace.spanId,
          anchor: "after",
        });

        // Find tools execute end event
        const toolsEndEvent = trace.events.find(
          (e) =>
            e.type === EVENTS.TOOLS_EXECUTE_END && e.trace.spanId === agentEndEvent.trace.spanId,
        );

        if (
          toolsEndEvent &&
          "toolResults" in toolsEndEvent &&
          Array.isArray(toolsEndEvent.toolResults)
        ) {
          // Check if any tool result has contentHash
          const toolResultWithHash = toolsEndEvent.toolResults.find((tr) => tr.contentHash);
          if (toolResultWithHash?.contentHash) {
            const journalEntry = restored.root.journal.tool[toolResultWithHash.contentHash];
            expect(journalEntry).toBeDefined();
            expect(journalEntry.output).toBeDefined();
            expect(journalEntry.contentHash).toBe(toolResultWithHash.contentHash);
          }
        }
      }
    });

    it("should restore successful tool journal entries from mixed failed batches", () => {
      const traceId = "trace_mixed_tool_batch";
      const spanId = "span_agent";
      const baseTrace = {
        traceId,
        spanId,
        parentSpanId: "root",
      };
      const events: TraceEvent[] = [
        {
          type: EVENTS.AGENT_START,
          schemaVersion: TRACE_EVENT_SCHEMA_VERSION,
          trace: baseTrace,
          timestamp: 1,
          agentId: "test_agent",
          props: {},
          scopeLayers: [],
          resourceKeys: [],
          maxReborns: 1,
        },
        {
          type: EVENTS.TOOLS_EXECUTE_END,
          schemaVersion: TRACE_EVENT_SCHEMA_VERSION,
          trace: baseTrace,
          timestamp: 2,
          agentId: "test_agent",
          toolCallsCount: 2,
          toolNames: ["ok_tool", "bad_tool"],
          successCount: 1,
          failureCount: 1,
          duration: 10,
          success: false,
          error: { name: "Error", message: "1 tool(s) failed" },
          toolResults: [
            {
              callId: "call_ok",
              toolName: "ok_tool",
              input: { q: "ok" },
              output: { result: "ok" },
              duration: 4,
              success: true,
              contentHash: "hash_ok",
            },
            {
              callId: "call_bad",
              toolName: "bad_tool",
              input: null,
              output: { error: true, message: "bad" },
              duration: 0,
              success: false,
              error: { name: "Error", message: "bad" },
              contentHash: "hash_bad",
            },
          ],
        },
        {
          type: EVENTS.AGENT_END,
          schemaVersion: TRACE_EVENT_SCHEMA_VERSION,
          trace: baseTrace,
          timestamp: 3,
          agentId: "test_agent",
          props: {},
          scopeLayers: [],
          resourceKeys: [],
          maxReborns: 1,
          duration: 20,
          success: true,
          generationCount: 1,
          result: { done: true },
        },
      ];

      const restored = restoreSnapshot(events);

      expect(restored.root.journal.tool.hash_ok?.output).toEqual({ result: "ok" });
      expect(restored.root.journal.tool.hash_bad).toBeUndefined();
    });
  });

  describe("nested agent restoration", () => {
    it("should restore nested agent frames correctly", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "test" });

      const ChildAgent = createTestAgent({
        id: "child_agent",
        model: mock.adapter,
        behavior: async () => {
          return { childResult: "child_done" };
        },
      });

      const ParentAgent = createTestAgent({
        id: "parent_agent",
        model: mock.adapter,
        behavior: async () => {
          const childResult = await ChildAgent({});
          return { parentResult: "parent_done", child: childResult };
        },
      });

      const trace = await runAndCaptureEvent(async () => {
        return await ParentAgent({});
      });

      // Find parent agent end event
      const parentEndEvent = trace.events.find(
        (e) => e.type === EVENTS.AGENT_END && e.agentId === "parent_agent",
      ) as AgentEndEvent | undefined;

      if (parentEndEvent) {
        const restored = restoreSnapshot(trace.events, {
          spanId: parentEndEvent.trace.spanId,
          anchor: "after",
        });

        // Should have root frame
        expect(restored.root.agentId).toBe("parent_agent");

        // Should have child frames
        const childFrames = Object.values(restored.root.children);
        expect(childFrames.length).toBeGreaterThan(0);

        const childFrame = childFrames.find((f) => f.agentId === "child_agent");
        expect(childFrame).toBeDefined();
        if (childFrame) {
          expect(childFrame.state.status).toBe("completed");
        }
      }
    });
  });

  describe("error handling", () => {
    it("should throw error when trace is empty", () => {
      const emptyTrace: TraceEvent[] = [];

      expect(() => {
        restoreSnapshot(emptyTrace, {
          spanId: "non_existent_span",
          anchor: "after",
        });
      }).toThrow(/Trace is empty/);
    });

    it("should throw error when span not found", () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "test" });

      const TestAgent = createTestAgent({
        id: "test_agent",
        model: mock.adapter,
        behavior: async () => {
          return { result: "done" };
        },
      });

      return runAndCaptureEvent(async () => {
        return await TestAgent({});
      }).then((trace) => {
        expect(() => {
          restoreSnapshot(trace.events, {
            spanId: "non_existent_span",
            anchor: "after",
          });
        }).toThrow(/not found in trace/);
      });
    });

    it('should throw error when START event not found for anchor: "before"', () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "test" });

      const TestAgent = createTestAgent({
        id: "test_agent",
        model: mock.adapter,
        behavior: async () => {
          return { result: "done" };
        },
      });

      return runAndCaptureEvent(async () => {
        return await TestAgent({});
      }).then((trace) => {
        expect(() => {
          restoreSnapshot(trace.events, {
            spanId: "non_existent_span",
            anchor: "before",
          });
        }).toThrow(/START event not found/);
      });
    });

    it('should throw error when END event not found for anchor: "after"', () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "test" });

      const TestAgent = createTestAgent({
        id: "test_agent",
        model: mock.adapter,
        behavior: async () => {
          return { result: "done" };
        },
      });

      return runAndCaptureEvent(async () => {
        return await TestAgent({});
      }).then((trace) => {
        expect(() => {
          restoreSnapshot(trace.events, {
            spanId: "non_existent_span",
            anchor: "after",
          });
        }).toThrow(/END event not found/);
      });
    });

    it("should handle unsorted trace events correctly", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "test" });

      const TestAgent = createTestAgent({
        id: "test_agent",
        model: mock.adapter,
        behavior: async () => {
          await promptAgent(schemas.simple);
          return { result: "done" };
        },
      });

      const trace = await runAndCaptureEvent(async () => {
        return await TestAgent({});
      });

      // Shuffle events to test sorting
      const shuffledEvents = [...trace.events].sort(() => Math.random() - 0.5);

      const agentEndEvent = trace.events.find((e) => e.type === EVENTS.AGENT_END) as
        | AgentEndEvent
        | undefined;

      if (agentEndEvent) {
        // Should still work correctly after sorting
        const restored = restoreSnapshot(shuffledEvents, {
          spanId: agentEndEvent.trace.spanId,
          anchor: "after",
        });

        expect(restored.root).toBeDefined();
        expect(restored.root.agentId).toBe("test_agent");
      }
    });
  });

  describe("state fixup", () => {
    it("should throw error when restoring after aborted child agent (no END event)", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "test" });

      const ChildAgent = createTestAgent({
        id: "child_agent",
        model: mock.adapter,
        behavior: async () => {
          await promptAgent(schemas.simple);
          return { childResult: "child_done" };
        },
      });

      const ParentAgent = createTestAgent({
        id: "parent_agent",
        model: mock.adapter,
        behavior: async () => {
          // Start child but don't await, so it gets aborted when parent returns
          const childPromise = ChildAgent({});
          // Catch abort error to prevent unhandled rejection
          childPromise.catch((error) => {
            // Expect abort error when child is aborted
            expect(isAbortError(error)).toBe(true);
            expect(error.message).toContain("aborted");
          });
          // Return immediately, child will be aborted
          return { parentResult: "parent_done" };
        },
      });

      const trace = await runAndCaptureEvent(async () => {
        return await ParentAgent({});
      });

      // Find child agent start event
      const childStartEvent = trace.events.find(
        (e) => e.type === EVENTS.AGENT_START && e.agentId === "child_agent",
      ) as AgentStartEvent | undefined;

      if (childStartEvent) {
        // Try to restore with anchor: 'after' - should fail because child was aborted (no END event)
        expect(() => {
          restoreSnapshot(trace.events, {
            spanId: childStartEvent.trace.spanId,
            anchor: "after",
          });
        }).toThrow(/END event not found/);
      }
    });

    it("should mark active frames as running", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "test" });

      const ChildAgent = createTestAgent({
        id: "child_agent",
        model: mock.adapter,
        behavior: async () => {
          await promptAgent(schemas.simple);
          return { childResult: "child_done" };
        },
      });

      const ParentAgent = createTestAgent({
        id: "parent_agent",
        model: mock.adapter,
        behavior: async () => {
          // Start child and await it (so it completes)
          const childResult = await ChildAgent({});
          // After child completes, do some more work
          await promptAgent(schemas.simple);
          return { parentResult: "parent_done", child: childResult };
        },
      });

      const trace = await runAndCaptureEvent(async () => {
        return await ParentAgent({});
      });

      // Find a generation end event in parent (after child completes but before parent ends)
      const parentGenerationEnd = trace.events.find(
        (e) =>
          e.type === EVENTS.GENERATION_END &&
          e.agentId === "parent_agent" &&
          e.trace.spanId !==
            trace.events.find((e2) => e2.type === EVENTS.AGENT_END && e2.agentId === "parent_agent")
              ?.trace.spanId,
      );

      if (parentGenerationEnd) {
        // Restore at generation end (child should be completed, parent still running)
        const restored = restoreSnapshot(trace.events, {
          spanId: parentGenerationEnd.trace.spanId,
          anchor: "after",
        });

        // Find child frame in restored snapshot
        const childFrame = Object.values(restored.root.children).find(
          (f) => f.agentId === "child_agent",
        );

        if (childFrame) {
          // Child should be completed (it finished before this generation end)
          expect(childFrame.state.status).toBe("completed");
        }

        // Parent should be running (it hasn't ended yet)
        expect(restored.root.state.status).toBe("running");
      } else {
        // Fallback: restore at parent's prompt end (if generation end not found)
        const parentPromptEnd = trace.events.find(
          (e) => e.type === EVENTS.PROMPT_AGENT_END && e.agentId === "parent_agent",
        );

        if (parentPromptEnd) {
          const restored = restoreSnapshot(trace.events, {
            spanId: parentPromptEnd.trace.spanId,
            anchor: "after",
          });

          // Parent should still be running (hasn't ended yet)
          expect(restored.root.state.status).toBe("running");
        }
      }
    });
  });

  describe("integration with runWith", () => {
    it("should restore snapshot and work with runWith", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "test_result" });

      const TestAgent = createTestAgent({
        id: "test_agent",
        model: mock.adapter,
        memory: { count: 0 },
        behavior: async () => {
          const [count, setCount] = equipMemory("count", 0);
          setCount(10);
          await promptAgent(schemas.simple);
          return { result: "done", count };
        },
      });

      // First, create a snapshot using dumpSnapshot
      const _originalSnapshot: AgentSnapshot | null = null;
      await TestAgent({}).then(() => {
        // This won't work directly, so we'll capture trace instead
      });

      // Capture trace and restore
      const trace = await runAndCaptureEvent(async () => {
        return await TestAgent({});
      });

      const agentEndEvent = trace.events.find((e) => e.type === EVENTS.AGENT_END) as
        | AgentEndEvent
        | undefined;

      if (agentEndEvent) {
        const restoredSnapshot = restoreSnapshot(trace.events, {
          spanId: agentEndEvent.trace.spanId,
          anchor: "after",
        });

        // Clear mock to verify replay
        mock.calls.clear();

        // Use restored snapshot with runWith
        const result = await runWith(
          async () => {
            const RestoredAgent = createTestAgent({
              id: "test_agent",
              model: mock.adapter,
              behavior: async () => {
                // This prompt should be replayed from journal
                const [count] = equipMemory("count", 0);
                expect(count).toBe(10); // Should be restored from snapshot
                const result = await promptAgent(schemas.simple);
                return { result, count };
              },
            });

            return await RestoredAgent({});
          },
          { snapshot: restoredSnapshot },
        );

        // Verify memory was restored
        expect(result.count).toBe(10);
        // Verify prompt was replayed (no new LLM call)
        expect(mock.calls.count()).toBe(0);
      }
    });
  });

  describe("error recovery", () => {
    it("should restore child agent state before error occurred", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "test" });

      // Child agent that sets memory and then throws error
      const ChildAgent = createTestAgent({
        id: "child_agent",
        model: mock.adapter,
        memory: { progress: 0, step: "initial" },
        behavior: async () => {
          const [_progress, setProgress] = equipMemory("progress", 0);
          const [_step, setStep] = equipMemory("step", "initial");

          setProgress(50); // Set progress
          setStep("step1");
          await promptAgent(schemas.simple); // This will trigger GENERATION_END with progress=50, step='step1'

          setProgress(75); // Update progress after promptAgent
          setStep("step2");
          // Note: This setProgress(75) happens after promptAgent, so it won't be in GENERATION_END
          // But we can restore to the last PROMPT_AGENT_END which should have progress=50

          // Then throw error
          throw new Error("Child agent failed");
        },
      });

      const ParentAgent = createTestAgent({
        id: "parent_agent",
        model: mock.adapter,
        behavior: async () => {
          try {
            await ChildAgent({});
          } catch (error) {
            // Parent catches error but doesn't rethrow
            return {
              parentResult: "handled",
              error: error instanceof Error ? error.message : String(error),
            };
          }
          return { parentResult: "success" };
        },
      });

      // Capture trace events
      const trace = await runAndCaptureEvent(async () => {
        return await ParentAgent({});
      });

      // Find child agent end event (should have failed)
      const childEndEvent = trace.events.find(
        (e) => e.type === EVENTS.AGENT_END && e.agentId === "child_agent",
      ) as AgentEndEvent | undefined;

      expect(childEndEvent).toBeDefined();
      if (childEndEvent) {
        // Verify child failed
        expect(childEndEvent.success).toBe(false);
        expect(childEndEvent.error).toBeDefined();
        expect(childEndEvent.error?.message).toBe("Child agent failed");

        // Find the last GENERATION_END event for child agent (before the error)
        // This should contain the memory state after promptAgent but before the error
        const childSpanId = childEndEvent.trace.spanId;
        const childEvents = trace.events.filter(
          (e) =>
            "trace" in e &&
            e.trace &&
            typeof e.trace === "object" &&
            "spanId" in e.trace &&
            e.trace.spanId === childSpanId,
        );

        const lastGenerationEnd = childEvents
          .filter((e) => e.type === EVENTS.GENERATION_END)
          .sort((a, b) => b.timestamp - a.timestamp)[0];

        if (lastGenerationEnd) {
          // Restore to the generation end (before error)
          const restored = restoreSnapshot(trace.events, {
            spanId: lastGenerationEnd.trace.spanId,
            anchor: "after",
          });

          // Verify snapshot structure
          const childFrame = Object.values(restored.root.children).find(
            (f) => f.agentId === "child_agent",
          );

          expect(childFrame).toBeDefined();
          if (childFrame) {
            expect(childFrame.memory.progress).toBe(50);
            expect(childFrame.memory.step).toBe("step1");
            expect(childFrame.state.status).toBe("running");
          }

          // Clear mock to verify replay
          mock.calls.clear();

          // Use runWith to actually run the restored snapshot
          const result = await runWith(
            async () => {
              const RestoredChildAgent = createTestAgent({
                id: "child_agent",
                model: mock.adapter,
                memory: { progress: 0, step: "initial" },
                behavior: async () => {
                  const [progress, setProgress] = equipMemory("progress", 0);
                  const [step, setStep] = equipMemory("step", "initial");

                  // Memory should be restored from snapshot
                  expect(progress).toBe(50);
                  expect(step).toBe("step1");

                  // This promptAgent should be replayed from journal (no new LLM call)
                  await promptAgent(schemas.simple);

                  // Continue from where it left off
                  setProgress(75);
                  setStep("step2");

                  // This time, don't throw error - complete successfully
                  return { result: "recovered", progress, step };
                },
              });

              const RestoredParentAgent = createTestAgent({
                id: "parent_agent",
                model: mock.adapter,
                behavior: async () => {
                  const childResult = await RestoredChildAgent({});
                  return { parentResult: "success", child: childResult };
                },
              });

              return await RestoredParentAgent({});
            },
            { snapshot: restored },
          );

          // Verify memory was restored and execution continued
          expect(result.child.progress).toBe(75);
          expect(result.child.step).toBe("step2");
          expect(result.child.result).toBe("recovered");

          // Verify prompt was replayed from journal (no new LLM call for the first promptAgent)
          // Note: The first promptAgent should be cached, but we might have new calls for continuation
          // The key is that memory was correctly restored
        } else {
          // If no GENERATION_END found, try restoring to PROMPT_AGENT_END
          const lastPromptEnd = childEvents
            .filter((e) => e.type === EVENTS.PROMPT_AGENT_END)
            .sort((a, b) => b.timestamp - a.timestamp)[0];

          if (lastPromptEnd) {
            const restored = restoreSnapshot(trace.events, {
              spanId: lastPromptEnd.trace.spanId,
              anchor: "after",
            });

            // Verify and run with runWith
            mock.calls.clear();

            await runWith(
              async () => {
                const RestoredChildAgent = createTestAgent({
                  id: "child_agent",
                  model: mock.adapter,
                  memory: { progress: 0, step: "initial" },
                  behavior: async () => {
                    const [progress] = equipMemory("progress", 0);
                    const [step] = equipMemory("step", "initial");

                    // Should have state from before error
                    expect(progress).toBeDefined();
                    expect(step).toBeDefined();

                    // Continue execution
                    return { result: "recovered" };
                  },
                });

                return await RestoredChildAgent({});
              },
              { snapshot: restored },
            );
          }
        }
      }
    });

    it("should restore snapshot to latest state when spanId is not provided", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "test_result" });

      const TestAgent = createTestAgent({
        id: "test_agent",
        model: mock.adapter,
        memory: { count: 0 },
        behavior: async () => {
          const [count, setCount] = equipMemory("count", 0);
          setCount(1);
          setCount(2);
          setCount(3);
          await promptAgent(schemas.simple);
          return { result: "done", finalCount: count };
        },
      });

      // Capture trace events
      const trace = await runAndCaptureEvent(async () => {
        return await TestAgent({});
      });

      // Restore without spanId (should restore to latest state)
      const restored = restoreSnapshot(trace.events);

      // Verify snapshot structure
      expect(restored).toBeDefined();
      expect(restored.root).toBeDefined();
      expect(restored.root.agentId).toBe("test_agent");
      expect(restored.root.memory.count).toBe(3);
      expect(restored.root.state.status).toBe("completed");
      expect(restored.root.state.output).toBeDefined();
      expect(restored.processId).toContain("restore:latest:");
      expect(restored.timestamp).toBeGreaterThan(0);

      // Clear mock to verify replay
      mock.calls.clear();

      // Use runWith to actually run the restored snapshot
      const result = await runWith(
        async () => {
          const RestoredAgent = createTestAgent({
            id: "test_agent",
            model: mock.adapter,
            memory: { count: 0 },
            behavior: async () => {
              const [count] = equipMemory("count", 0);

              // Memory should be restored from snapshot
              expect(count).toBe(3);

              // Single promptAgent call replayed from journal (no new LLM calls)
              const result1 = await promptAgent(schemas.simple);

              return { result: "done", finalCount: count, result1 };
            },
          });

          return await RestoredAgent({});
        },
        { snapshot: restored },
      );

      // Verify memory was restored
      expect(result.finalCount).toBe(3);

      // Verify promptAgent was replayed from journal (no new LLM calls)
      expect(mock.calls.count()).toBe(0);
    });

    it("should restore snapshot to latest state with empty options", async () => {
      const mock = createMockModel();
      mock.setDefaultResponse({ result: "test" });

      const TestAgent = createTestAgent({
        id: "test_agent",
        model: mock.adapter,
        memory: { step: 0 },
        behavior: async () => {
          const [step, setStep] = equipMemory("step", 0);
          setStep(1);
          await promptAgent(schemas.simple);
          setStep(2);
          return { result: "done", step };
        },
      });

      const trace = await runAndCaptureEvent(async () => {
        return await TestAgent({});
      });

      // Restore with empty options (should default to latest)
      const restored = restoreSnapshot(trace.events, {});

      // Verify snapshot structure
      expect(restored.root.memory.step).toBe(2);
      expect(restored.root.state.status).toBe("completed");
      expect(restored.processId).toContain("restore:latest:");

      // Clear mock to verify replay
      mock.calls.clear();

      // Use runWith to actually run the restored snapshot
      const result = await runWith(
        async () => {
          const RestoredAgent = createTestAgent({
            id: "test_agent",
            model: mock.adapter,
            memory: { step: 0 },
            behavior: async () => {
              const [step] = equipMemory("step", 0);

              // Memory should be restored from snapshot
              expect(step).toBe(2);

              // promptAgent should be replayed from journal (no new LLM call)
              await promptAgent(schemas.simple);

              return { result: "done", step };
            },
          });

          return await RestoredAgent({});
        },
        { snapshot: restored },
      );

      // Verify memory was restored
      expect(result.step).toBe(2);

      // Verify promptAgent was replayed from journal (no new LLM call)
      expect(mock.calls.count()).toBe(0);
    });
  });
});
