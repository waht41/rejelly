/**
 * Fan-in / Fan-out Example
 *
 * - Fan-out: Orchestrator runs multiple worker agents in parallel (Promise.all).
 * - Fan-in: Results are collected and passed to a summarizer agent.
 */

import type { ExampleModule } from "@shared/types";
import { OrchestratorAgent } from "./fan-in-fan-out";

export const meta = {
  name: "Fan-in / Fan-out",
  description: "Parallel worker agents (fan-out) then single summarizer (fan-in)",
  order: 31,
};

async function runExample(topic: string) {
  console.log("Topic:", topic);
  console.log("Running: fan-out (3 workers in parallel) -> fan-in (summarizer)...\n");
  const result = await OrchestratorAgent({ topic });
  console.log("--- Sections (from workers) ---");
  for (const s of result.sections) {
    console.log(`[${s.subtask}]`, s.summary.slice(0, 120) + (s.summary.length > 120 ? "..." : ""));
  }
  console.log("\n--- Final summary (fan-in) ---");
  console.log(result.finalSummary);
}

async function run() {
  console.log("=== Fan-in / Fan-out ===\n");
  await runExample("renewable energy");
}

export const examples = {
  default: {
    title: "Fan-out 3 workers → fan-in summarizer",
    description: "Parallel workers (causes, status, outlook) then single summarizer",
    run,
  },
} satisfies ExampleModule["examples"];
