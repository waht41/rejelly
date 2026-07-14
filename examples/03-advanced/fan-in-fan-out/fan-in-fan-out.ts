/**
 * Fan-out / Fan-in Example
 *
 * - Fan-out: Orchestrator spawns multiple worker agents in parallel (Promise.all).
 * - Fan-in: Collect all worker results, then pass to a summarizer agent for final output.
 *
 * Flow: Orchestrator -> [Worker1, Worker2, Worker3] (parallel) -> Summarizer -> result
 */

import { createAgent, equipInstruction, equipSystem, promptAgent } from "@rejelly/core";
import { getModel } from "@shared/runtime-model";
import { z } from "zod";

const SUBTASKS = ["causes", "current status", "future outlook"] as const;
const model = getModel();

const WorkerSummarySchema = z.object({
  summary: z.string().describe("One short paragraph for this aspect"),
});

const WorkerAgent = createAgent({
  id: "fanout_worker",
  model,
  handler: async (props: { topic: string; subtask: string }) => {
    equipSystem(
      "You are a concise analyst. Produce exactly one short paragraph (2-4 sentences) for the requested aspect. No preamble.",
    );
    equipInstruction(
      `Topic: ${props.topic}. Aspect to analyze: "${props.subtask}". Output only the paragraph.`,
    );
    const result = await promptAgent(WorkerSummarySchema);
    return { subtask: props.subtask, summary: result.summary };
  },
});

const FinalSummarySchema = z.object({
  finalSummary: z.string().describe("A brief overall summary tying all sections together"),
});

const SummarizerAgent = createAgent({
  id: "fanin_summarizer",
  model,
  handler: async (props: {
    topic: string;
    sections: Array<{ subtask: string; summary: string }>;
  }) => {
    equipSystem(
      "You are a summarizer. Given a topic and several section summaries, produce one short overall summary (2-4 sentences) that ties them together.",
    );
    const sectionsText = props.sections.map((s) => `[${s.subtask}]\n${s.summary}`).join("\n\n");
    equipInstruction(`Topic: ${props.topic}\n\nSections:\n${sectionsText}`);
    const result = await promptAgent(FinalSummarySchema);
    return result.finalSummary;
  },
});

export interface FanInFanOutResult {
  sections: Array<{ subtask: string; summary: string }>;
  finalSummary: string;
}

export const OrchestratorAgent = createAgent({
  id: "fanin_fanout_orchestrator",
  model,
  handler: async (props: { topic: string }): Promise<FanInFanOutResult> => {
    // Fan-out: run worker agents in parallel
    const sectionPromises = SUBTASKS.map((subtask) => WorkerAgent({ topic: props.topic, subtask }));
    const sections = await Promise.all(sectionPromises);

    // Fan-in: pass all results to summarizer
    const finalSummary = await SummarizerAgent({
      topic: props.topic,
      sections,
    });

    return { sections, finalSummary };
  },
});
