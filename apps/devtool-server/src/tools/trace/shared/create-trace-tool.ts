import type { ToolDefinition } from "@rejelly/core";
import { z } from "zod";
import type { TraceProfileExecutionNode } from "../../../services/trace-profile.service";
import {
  createTraceIdParameter,
  normalizeTraceToolContext,
  type TraceToolContextInput,
} from "./default-trace-context";
import { normalizeNodeRefs, TraceQuery } from "./trace-query";

const NodeRefParameter = z
  .union([z.string(), z.array(z.string()).min(1)])
  .describe("Node reference(s) from get_trace_profile, for example n4 or [n4, n8].");

type NodeScopedArgs = {
  traceId?: string;
  nodeRef?: string | string[];
};

interface NodeScopedToolSpec {
  name: string;
  description: string;
  unavailableMessage: string;
  nodeRefRequired?: boolean;
  defaultToLastTurn?: boolean;
  requireTurn?: boolean;
  notFoundMessage: (ref?: string) => string;
  notTurnMessage?: (node: TraceProfileExecutionNode) => string;
  format: (query: TraceQuery, node: TraceProfileExecutionNode) => string;
}

export function createNodeScopedTool(
  spec: NodeScopedToolSpec,
  contextInput?: TraceToolContextInput,
): ToolDefinition {
  const context = normalizeTraceToolContext(contextInput);
  const traceIdParameter = createTraceIdParameter(context, "using");
  const parameters = spec.nodeRefRequired
    ? z.object({
        traceId: traceIdParameter,
        nodeRef: NodeRefParameter,
      })
    : z.object({
        traceId: traceIdParameter,
        nodeRef: NodeRefParameter.optional(),
      });

  return {
    name: spec.name,
    description: spec.description,
    parameters,
    handler: async ({ traceId, nodeRef }: NodeScopedArgs) => {
      const targetTraceId = traceId ?? context.traceId;
      if (!targetTraceId) return spec.unavailableMessage;

      const query = await TraceQuery.load(targetTraceId);
      const sections = normalizeNodeRefs(nodeRef).map((ref) => {
        const node = resolveNode(query, ref, spec);
        if (!node) return spec.notFoundMessage(ref);
        if (spec.requireTurn && node.type !== "turn") {
          return spec.notTurnMessage?.(node) ?? spec.notFoundMessage(ref);
        }
        return spec.format(query, node);
      });

      return sections.join("\n\n---\n\n");
    },
  };
}

function resolveNode(
  query: TraceQuery,
  ref: string | undefined,
  spec: NodeScopedToolSpec,
): TraceProfileExecutionNode | undefined {
  if (ref) return query.findNode(ref);
  if (spec.defaultToLastTurn) return query.lastTurn();
  return spec.nodeRefRequired ? undefined : query.lastTurn();
}
