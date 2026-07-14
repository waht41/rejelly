/**
 * Graph Policy Example
 *
 * A LangGraph-style graph (typed state, conditional edges, a cycle, parallel
 * fan-out) implemented as a custom prompt policy on public core primitives —
 * core itself stays graph-unaware.
 */

import type { ExampleModule } from "@shared/types";
import { WriterCriticAgent } from "./writer-critic-agent";

export const meta = {
  name: "Graph Policy",
  description: "LangGraph-style writer–critic graph as a custom prompt policy",
  order: 32,
};

async function run() {
  console.log("=== Graph Policy: writer–critic refine loop ===\n");

  const topic = "how prompt caching reduces LLM latency";
  console.log("Topic:", topic);
  console.log(
    "Graph: draft -> critique (2 critics in parallel) -> [approve ? END : revise -> critique]\n",
  );

  const result = await WriterCriticAgent({ topic });

  console.log("--- Graph traversal ---");
  console.log("Path:", [...result.path, "END"].join(" -> "));
  console.log("Revise rounds:", result.state.rounds);
  console.log(
    "Outcome:",
    result.state.approved ? "approved by both critics" : "shipped on turn-budget degradation",
  );
  if (!result.state.approved && result.state.feedback.length > 0) {
    console.log("Unresolved feedback:", result.state.feedback.join(" | "));
  }

  console.log("\n--- Intermediate process ---");
  for (const draft of result.state.drafts) {
    const title = draft.source === "draft" ? "Initial draft" : `Revision round ${draft.round}`;
    console.log(`\n[${title}]`);
    console.log(draft.text);

    const critiques = result.state.critiques.filter((item) => item.round === draft.round);
    if (critiques.length > 0) {
      console.log("\nCritiques:");
      for (const [index, critique] of critiques.entries()) {
        console.log(
          `  ${index + 1}. ${critique.approved ? "approved" : "needs work"} ` +
            `(${critique.persona}): ${critique.feedback}`,
        );
      }
    }
  }

  console.log("\n--- Final draft ---");
  console.log(result.final);
}

export const examples = {
  default: {
    title: "Writer–critic refine loop",
    description: "Conditional edge + cycle + parallel critics, inside one generation",
    run,
  },
} satisfies ExampleModule["examples"];
