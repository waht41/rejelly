/** Audit-only gateway binding: shared runtime, isolated per-seed intake/call budgets. */

import type { ToolDefinition } from "@rejelly/core";
import type { McpBoundRoute } from "../contracts";
import type { McpRuntimeManager } from "../runtime/runtimeManager";
import { type McpGatewayDispatch, referenceMcpTools } from "./dispatch";
import { createMcpGatewayToolDefinitions } from "./gatewayTools";
import { McpCallPolicy } from "./mcpCallPolicy";

export const MCP_AUDIT_PROVENANCE_RESOURCE_KEY = "mcp:audit-provenance";

export interface McpAuditProvenance {
  readonly serverId: string;
  readonly configFingerprint: string;
  readonly catalogRevision: string;
}

export class McpAuditProvenanceCollector {
  readonly #entries = new Map<string, McpAuditProvenance>();

  record(route: McpBoundRoute): void {
    const entry = Object.freeze({
      serverId: route.identity.serverId,
      configFingerprint: route.configFingerprint,
      catalogRevision: route.catalogRevision,
    });
    this.#entries.set(JSON.stringify(entry), entry);
  }

  snapshot(): readonly McpAuditProvenance[] {
    return Object.freeze(
      [...this.#entries.values()].sort(
        (left, right) =>
          left.serverId.localeCompare(right.serverId) ||
          left.catalogRevision.localeCompare(right.catalogRevision),
      ),
    );
  }
}

function encodedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function createAuditMcpDispatch(
  manager: McpRuntimeManager,
  provenance: McpAuditProvenanceCollector,
): McpGatewayDispatch {
  const binding = manager.captureDispatchBinding("audit");
  const callsByServer = new Map<string, number>();
  const resultBytesByServer = new Map<string, number>();
  return Object.freeze({
    binding,
    invoke: async (route: McpBoundRoute, argumentsValue: Record<string, unknown>) => {
      const serverId = route.identity.serverId;
      const limits = manager.getAuditLimits(serverId);
      if (!limits) {
        return {
          ok: false as const,
          code: "tool_unavailable" as const,
          message: "The MCP server has no Audit policy.",
        };
      }
      const calls = callsByServer.get(serverId) ?? 0;
      if (calls >= limits.maxCallsPerSeed) {
        return {
          ok: false as const,
          code: "call_budget_exceeded" as const,
          message: `Audit MCP call budget exhausted for ${serverId}.`,
        };
      }
      callsByServer.set(serverId, calls + 1);
      const outcome = await manager.callBoundTool("audit", route, argumentsValue);
      if (!outcome.ok) return outcome;
      provenance.record(route);
      const resultBytes = (resultBytesByServer.get(serverId) ?? 0) + encodedBytes(outcome.result);
      resultBytesByServer.set(serverId, resultBytes);
      if (resultBytes > limits.maxResultBytesPerSeed) {
        return {
          ok: false as const,
          code: "result_too_large" as const,
          message: `Audit MCP result budget exhausted for ${serverId}.`,
        };
      }
      return outcome;
    },
  });
}

export function createAuditMcpGatewayTools(
  manager: McpRuntimeManager,
  provenance: McpAuditProvenanceCollector,
): readonly ToolDefinition[] {
  const dispatch = createAuditMcpDispatch(manager, provenance);
  // Discovery is allowed to observe readiness at invocation time. The call side keeps the exact
  // binding that produced the latest reference and still passes manager freshness before I/O.
  let currentBinding = dispatch.binding;
  const tools = createMcpGatewayToolDefinitions({
    reference: async (input) => {
      currentBinding = manager.captureDispatchBinding("audit");
      return referenceMcpTools(currentBinding, input);
    },
    callPolicy: new McpCallPolicy({
      resolveRoute: (identity) => currentBinding.route(identity),
      invoke: dispatch.invoke,
    }),
  });
  return tools as unknown as readonly ToolDefinition[];
}
