/**
 * Mini graph-policy runtime (example-land, NOT part of core).
 *
 * Demonstrates that a LangGraph-style strategy is "just a policy": nodes are
 * `executeTurn` calls, edges are plain control flow, state is a local object —
 * and the whole graph runs inside one generation, so the agent handler still
 * sees a single prompt call.
 *
 * Built only on public core primitives:
 * - `createAgentPolicy`: prompt lifecycle (draft barrier, telemetry, model resolution)
 * - `executeTurn`: one model call (journaled, so replay / time-travel safe)
 * - `executeValidation`: the final-output contract (`expectValidator` must run)
 */

import type { Message } from "@rejelly/core";
import {
  createAgentPolicy,
  createJsonOutputParser,
  executeTurn,
  executeValidation,
  normalizeMessages,
  type PromptContext,
  type PromptContextForkOptions,
  transferJsonSchema,
} from "@rejelly/core/policy";
import type { z } from "zod";

/** Terminal edge target: returning this from an edge ends the graph. */
export const END = "__end__";

export interface GraphHelpers {
  /** Derive a node-local prompt runtime without mutating the agent draft. */
  fork(options?: PromptContextForkOptions): PromptContext;
  /**
   * One model turn: runtime system + instruction as base, plus the given prompt.
   * Returns raw text.
   */
  callText(prompt: string, options?: { runtime?: PromptContext }): Promise<string>;
  /**
   * One model turn with structured output, parsed by the node's own schema.
   * Retries with error feedback up to the agent's `maxRetries` (each retry
   * consumes turn budget, same as promptAgent's validation retries).
   */
  callStructured<T extends z.ZodTypeAny>(
    prompt: string,
    schema: T,
    options?: { runtime?: PromptContext },
  ): Promise<z.infer<T>>;
  /**
   * Model turns left before `executeTurn` throws TurnBudgetExceededError.
   * Edges can read this to degrade gracefully (e.g. stop revising and ship)
   * instead of failing mid-graph.
   */
  remainingTurns(): number;
}

/** A node reads state, may call the model, and returns a partial state update (merged shallowly). */
export type GraphNode<S> = (state: S, g: GraphHelpers) => Promise<Partial<S>>;

/** After a node ran, its edge picks the next node id — or END to finish. */
export type GraphEdge<S> = (state: S, g: GraphHelpers) => string;

export interface GraphSpec<S> {
  entry: string;
  nodes: Record<string, GraphNode<S>>;
  edges: Record<string, GraphEdge<S>>;
}

export interface GraphPolicyOptions<S> {
  policyId: string;
  graph: GraphSpec<S>;
  /**
   * Extract the final raw text from the terminal state. It is run through
   * `executeValidation` (raw-text path), so `expectValidator()`s registered by
   * the agent apply to the graph's final output — the contract every custom
   * policy must honor.
   */
  finalText: (state: S) => string;
}

export interface GraphPolicyResult<S> {
  /** Final text, after expectValidator()s passed. */
  final: string;
  /** Terminal graph state, for callers that want intermediate artifacts. */
  state: S;
  /** Visited node ids in order (demo / debugging). */
  path: string[];
}

function createHelpers(ctx: PromptContext): GraphHelpers {
  // This demo keeps graph node model calls tool-free, but does it through a
  // node-local runtime fork rather than a naked executeTurn({ tools: [] })
  // override. A fuller runtime can fork per node with different tools and pass
  // the same runtime to executeTurn + executeTools.
  const modelOnlyRuntime = ctx.fork({ tools: [] });

  return {
    fork(options) {
      return ctx.fork(options);
    },

    async callText(prompt, options) {
      const runtime = options?.runtime ?? modelOnlyRuntime;
      const { message } = await executeTurn(
        normalizeMessages([...runtime.messages, { role: "user", content: prompt }]),
        { runtime },
      );
      return typeof message.content === "string" ? message.content : "";
    },

    async callStructured(prompt, schema, options) {
      const runtime = options?.runtime ?? modelOnlyRuntime;
      const jsonSchema = transferJsonSchema(schema);
      const parser = createJsonOutputParser(schema);
      const history: Message[] = normalizeMessages([
        ...runtime.messages,
        { role: "user", content: prompt },
      ]);
      let lastErrors: string[] = [];

      for (let attempt = 0; attempt <= ctx.maxRetries; attempt++) {
        const { message } = await executeTurn(history, { jsonSchema, runtime });
        const rawText = typeof message.content === "string" ? message.content : "";

        // Intermediate node output: parse with the node's own parser, on
        // purpose NOT via executeValidation — expectValidator() is the
        // agent-level contract for the FINAL output, and user validators must
        // not run against intermediate node outputs.
        const parsed = parser.parse(rawText);
        if (parsed.success) return parsed.data;

        lastErrors = parsed.errors;
        history.push({ role: "assistant", content: rawText || null });
        history.push({
          role: "user",
          content: `Output validation failed:\n${parsed.errors.join("\n")}\nReturn corrected JSON only.`,
        });
      }

      throw new Error(
        `[graph-policy] structured node output failed after ${ctx.maxRetries + 1} attempts:\n${lastErrors.join("\n")}`,
      );
    },

    remainingTurns() {
      return ctx.maxTurnSteps - ctx.usedTurnSteps;
    },
  };
}

async function runGraph<S>(
  ctx: PromptContext,
  spec: GraphSpec<S>,
  initialState: S,
  helpers: GraphHelpers,
): Promise<{ state: S; path: string[] }> {
  // Model calls are bounded by the engine's turn budget (TurnBudgetExceededError),
  // but an edge cycle that never calls the model would spin forever — cap node
  // visits as a cheap backstop.
  const maxNodeVisits = ctx.maxTurnSteps * 4;

  let state = { ...initialState };
  let nodeId = spec.entry;
  const path: string[] = [];

  while (nodeId !== END) {
    const node = spec.nodes[nodeId];
    if (!node) throw new Error(`[graph-policy] Unknown node "${nodeId}"`);
    path.push(nodeId);
    if (path.length > maxNodeVisits) {
      throw new Error(
        `[graph-policy] Node visits exceeded ${maxNodeVisits}; check edges for a model-free cycle.`,
      );
    }

    const update = await node(state, helpers);
    state = { ...state, ...update };

    const edge = spec.edges[nodeId];
    if (!edge) throw new Error(`[graph-policy] Node "${nodeId}" has no outgoing edge`);
    nodeId = edge(state, helpers);
  }

  return { state, path };
}

/**
 * Build a graph-shaped prompt policy. The returned function is used exactly
 * like `promptAgent`: call it once per generation from an agent handler, after
 * equips and expects.
 */
export function createGraphPolicy<S>(options: GraphPolicyOptions<S>) {
  return createAgentPolicy({
    policyId: options.policyId,
    handler: async (ctx: PromptContext, initialState: S): Promise<GraphPolicyResult<S>> => {
      ctx.span.setAttribute("graph.entry", options.graph.entry);
      ctx.span.setAttribute("graph.nodes", Object.keys(options.graph.nodes));

      const helpers = createHelpers(ctx);
      const { state, path } = await runGraph(ctx, options.graph, initialState, helpers);
      ctx.span.setAttribute("graph.path", path);

      // Final-output contract: the terminal text goes through executeValidation
      // (no parser => raw-text path, validators still run). A production policy
      // could route a validator failure back into a revise node instead of
      // throwing; kept minimal here.
      const validation = await executeValidation(options.finalText(state), { runtime: ctx });
      if (!validation.success) {
        throw new Error(
          `[graph-policy] final output failed validation:\n${validation.errors.join("\n")}`,
        );
      }

      return { final: validation.data as string, state, path };
    },
  });
}
