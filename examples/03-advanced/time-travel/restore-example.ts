/**
 * Restore snapshot example: capture trace events during a run → restoreSnapshot(events) →
 * runWith(..., { snapshot }) to replay. Use when you don't have enableSnapshot at runtime
 * (e.g. production): emit events, then restore snapshot locally for replay/debug.
 *
 * See docs/api/time-travel.md (restoreSnapshot) and docs/guide/event.md.
 */

import type { TraceEvent } from "@rejelly/core";
import {
  createAgent,
  equipInstruction,
  equipSystem,
  getGlobalEventBus,
  promptAgent,
  runWith,
} from "@rejelly/core";
import { restoreSnapshot } from "@rejelly/core/debugger";
import { getModel } from "@shared/runtime-model";
import { z } from "zod";

interface Props {
  query: string;
}

const JokeSchema = z.object({
  joke: z.string().describe("A short joke based on the user's topic"),
});

const AGENT_ID = "restore_demo_agent";
const SYSTEM_PROMPT =
  "You are a funny comedian. Your task is to make up a short, clean joke based on the user's request.";
const model = getModel();

const DemoAgent = createAgent({
  id: AGENT_ID,
  model,
  handler: async ({ query }: Props) => {
    equipSystem(SYSTEM_PROMPT);
    equipInstruction(query);
    const result = await promptAgent(JokeSchema);
    return result.joke;
  },
});

async function main() {
  const testQuery = "Tell me a joke about programmers";

  // 1) Subscribe to global event bus and collect events during run
  const events: TraceEvent[] = [];
  const unsub = getGlobalEventBus().subscribe("*", (e: TraceEvent) => events.push(e));

  console.log("========== Part 1: Run agent and capture trace events ==========");
  let firstResult: string;
  try {
    firstResult = await runWith(async () => DemoAgent({ query: testQuery }), {
      enableSnapshot: false,
    });
    console.log("First run result:", firstResult);
  } finally {
    unsub();
  }

  if (events.length === 0) {
    console.error("❌ No events captured.");
    return;
  }
  const traceId = events[0]?.trace?.traceId;
  const ourEvents = traceId ? events.filter((e) => e.trace?.traceId === traceId) : events;
  console.log(`\n✅ Captured ${ourEvents.length} trace events.`);

  // 2) Restore snapshot from events (default: restore to latest)
  const snapshot = restoreSnapshot(ourEvents);
  console.log("\n========== Part 2: Restore snapshot from events ==========");
  console.log("Restored snapshot:", snapshot.processId, "root.agentId:", snapshot.root.agentId);

  // 3) Replay with snapshot (promptAgent hits cache, no extra LLM call)
  console.log("\n========== Part 3: Replay with snapshot (no extra tokens) ==========");
  const replayResult = await runWith(async () => DemoAgent({ query: testQuery }), { snapshot });
  console.log("Replay result:", replayResult);
  console.log("\n🎉 Same result; replay used cached prompt, no new LLM call.");
}

export { main as runRestoreExample, DemoAgent };
