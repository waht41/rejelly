import type { Message } from "@rejelly/core";
import { MCP_CALL_TOOL_NAME, type McpToolIdentity, mcpCallInputSchema } from "./contracts";

export interface McpToolCallProvenance {
  readonly toolCallId: string;
  readonly tool: McpToolIdentity;
  readonly catalogRevision: string;
}

/** Read canonical MCP identity only from structured gateway arguments in retained history. */
export function projectMcpToolCallProvenance(
  messages: readonly Message[],
): readonly McpToolCallProvenance[] {
  const provenance: McpToolCallProvenance[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.tool_calls ?? []) {
      if (call.name !== MCP_CALL_TOOL_NAME) continue;
      let decoded: unknown;
      try {
        decoded = JSON.parse(call.arguments);
      } catch {
        continue;
      }
      const parsed = mcpCallInputSchema.safeParse(decoded);
      if (!parsed.success) continue;
      provenance.push({
        toolCallId: call.id,
        tool: parsed.data.tool,
        catalogRevision: parsed.data.catalogRevision,
      });
    }
  }
  return Object.freeze(provenance);
}
