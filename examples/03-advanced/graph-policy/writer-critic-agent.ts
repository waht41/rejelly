/**
 * Writer–Critic agent on top of the mini graph policy.
 *
 * Graph shape (LangGraph-style: typed state, conditional edge, a cycle):
 *
 *   draft ──► critique ──► END            (both critics approve, or budget low)
 *                │  ▲
 *                ▼  │
 *               revise                    (cycle back for another round)
 *
 * The critique node fans out two critic personas in parallel (Promise.all of
 * executeTurn) — parallel turns within one generation are journaled and
 * replay-safe.
 */

import { createAgent, equipInstruction, equipSystem, expectValidator } from "@rejelly/core";
import { getModel } from "@shared/runtime-model";
import { z } from "zod";
import { createGraphPolicy, END, type GraphSpec } from "./graph-policy";

const model = getModel();

export interface WriterState {
  topic: string;
  draft: string;
  /** Draft snapshots by round, including the initial draft and revisions. */
  drafts: Array<{
    round: number;
    source: "draft" | "revise";
    text: string;
  }>;
  /** Critic results grouped by the draft round they reviewed. */
  critiques: Array<{
    round: number;
    persona: string;
    approved: boolean;
    feedback: string;
  }>;
  /** Latest round's blocking feedback (empty when approved). */
  feedback: string[];
  approved: boolean;
  rounds: number;
}

const CritiqueSchema = z.object({
  approved: z.boolean().describe("true only if the draft needs no further edits"),
  feedback: z.string().describe("The single most important improvement, one sentence"),
});

const CRITIC_PERSONAS = [
  "a strict fact-and-clarity editor (vague claims, logical gaps)",
  "a style editor (flow, redundancy, weak verbs)",
];

const WriterCriticGraph: GraphSpec<WriterState> = {
  entry: "draft",
  nodes: {
    draft: async (state, g) => {
      const draft = await g.callText(
        `Write a tight ~120-word paragraph about "${state.topic}". No headings, no lists.`,
      );
      return {
        draft,
        drafts: [...state.drafts, { round: 0, source: "draft", text: draft }],
        rounds: 0,
      };
    },

    critique: async (state, g) => {
      // Fan-out: both critics review the same draft in parallel.
      const reviews = await Promise.all(
        CRITIC_PERSONAS.map((persona) =>
          g.callStructured(
            `You are ${persona}. Review this draft about "${state.topic}":\n\n${state.draft}`,
            CritiqueSchema,
          ),
        ),
      );
      const critiqueRound = state.rounds;
      return {
        approved: reviews.every((r) => r.approved),
        feedback: reviews.filter((r) => !r.approved).map((r) => r.feedback),
        critiques: [
          ...state.critiques,
          ...reviews.map((review, index) => ({
            round: critiqueRound,
            persona: CRITIC_PERSONAS[index] ?? `critic ${index + 1}`,
            approved: review.approved,
            feedback: review.feedback,
          })),
        ],
      };
    },

    revise: async (state, g) => {
      const draft = await g.callText(
        `Revise the draft below. Address every point of feedback; keep it ~120 words.\n\n` +
          `Draft:\n${state.draft}\n\nFeedback:\n${state.feedback.map((f) => `- ${f}`).join("\n")}`,
      );
      const nextRound = state.rounds + 1;
      return {
        draft,
        drafts: [...state.drafts, { round: nextRound, source: "revise", text: draft }],
        rounds: nextRound,
      };
    },
  },
  edges: {
    draft: () => "critique",
    // Conditional edge: ship when approved — or degrade gracefully when the
    // remaining turn budget can't cover another revise + 2-critic round
    // (1 + 2 turns, plus margin for callStructured retries).
    critique: (state, g) => (state.approved || g.remainingTurns() < 4 ? END : "revise"),
    revise: () => "critique",
  },
};

const promptWriterGraph = createGraphPolicy<WriterState>({
  policyId: "graph-writer-critic",
  graph: WriterCriticGraph,
  finalText: (state) => state.draft,
});

export const WriterCriticAgent = createAgent({
  id: "graph_writer_critic",
  model,
  // Graph nodes spend the same per-generation turn budget as any policy;
  // 1 draft + 2 critics + N × (1 revise + 2 critics) — 12 allows 2 full
  // revise rounds before the critique edge degrades to END.
  maxTurnSteps: 12,
  handler: async (props: { topic: string }) => {
    equipSystem("You are a precise technical writer. Plain language, concrete claims, no filler.");
    equipInstruction(`Audience: curious general readers. Topic: ${props.topic}`);

    // Applies to the graph's FINAL output only (the policy runs it via
    // executeValidation); intermediate node outputs are not affected.
    expectValidator(
      (text) =>
        (typeof text === "string" && text.length >= 100) ||
        "Final draft is too short to be a real paragraph.",
    );

    return await promptWriterGraph({
      topic: props.topic,
      draft: "",
      drafts: [],
      critiques: [],
      feedback: [],
      approved: false,
      rounds: 0,
    });
  },
});
