import {
  type McpNormalizedCallResult,
  normalizeMcpCallResult,
  validateMcpToolArguments,
} from "@rejelly/adapter-mcp";
import {
  MCP_CONTRACT_LIMITS,
  type McpBoundRoute,
  type McpCallInput,
  type McpCallPolicyResult,
  type McpCallRejectionCode,
  type McpToolIdentity,
} from "../contracts";

export type McpCallInvocationOutcome =
  | { readonly ok: true; readonly result: unknown }
  | {
      readonly ok: false;
      readonly code: McpCallRejectionCode;
      readonly message: string;
      readonly currentCatalogRevision?: string;
    };

export interface McpCallPolicyPorts {
  /** The dispatch binding decides visibility and routing; display names never participate. */
  resolveRoute(identity: McpToolIdentity): McpBoundRoute | undefined;
  /** T4 supplies approval, freshness, timeout, and client I/O behind this boundary. */
  invoke(
    route: McpBoundRoute,
    argumentsValue: Record<string, unknown>,
  ): Promise<McpCallInvocationOutcome>;
}

type McpRejectedCallResult = Extract<
  McpCallPolicyResult<McpNormalizedCallResult>,
  { status: "rejected" }
>;

function reject(
  input: McpCallInput,
  code: McpRejectedCallResult["code"],
  message: string,
  details: {
    readonly currentCatalogRevision?: string;
    readonly issues?: McpRejectedCallResult["issues"];
  } = {},
): McpCallPolicyResult<McpNormalizedCallResult> {
  return {
    type: "mcp_call_result_v1",
    status: "rejected",
    tool: input.tool,
    code,
    message,
    ...details,
  };
}

function jsonDepth(value: unknown): number {
  let maximum = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    maximum = Math.max(maximum, current.depth);
    if (current.value && typeof current.value === "object") {
      const children = Array.isArray(current.value)
        ? current.value
        : Object.values(current.value as Record<string, unknown>);
      for (const child of children) stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  return maximum;
}

/**
 * Stable policy shell for the effectful gateway. It performs every check that can be decided from
 * one dispatch binding before T4's approval/runtime port is allowed to perform I/O.
 */
export class McpCallPolicy {
  constructor(private readonly ports: McpCallPolicyPorts) {}

  async execute(input: McpCallInput): Promise<McpCallPolicyResult<McpNormalizedCallResult>> {
    const route = this.ports.resolveRoute(input.tool);
    if (!route) {
      return reject(
        input,
        "tool_unavailable",
        "The MCP tool is not available in this dispatch. Run mcp_reference again.",
      );
    }
    if (
      route.identity.serverId !== input.tool.serverId ||
      route.identity.nativeToolName !== input.tool.nativeToolName
    ) {
      return reject(
        input,
        "tool_unavailable",
        "The MCP route did not match the requested identity.",
      );
    }
    if (route.catalogRevision !== input.catalogRevision) {
      return reject(
        input,
        "catalog_changed",
        "The MCP catalog changed after this tool was referenced. Run mcp_reference again.",
        { currentCatalogRevision: route.catalogRevision },
      );
    }

    const encoded = JSON.stringify(input.arguments);
    if (Buffer.byteLength(encoded, "utf8") > MCP_CONTRACT_LIMITS.gatewayArgumentsBytes) {
      return reject(input, "arguments_too_large", "MCP tool arguments exceed the byte limit.");
    }
    if (jsonDepth(input.arguments) > MCP_CONTRACT_LIMITS.gatewayArgumentsDepth) {
      return reject(input, "arguments_too_deep", "MCP tool arguments exceed the nesting limit.");
    }

    const validation = validateMcpToolArguments(route.inputSchema, input.arguments);
    if (!validation.ok) {
      return reject(
        input,
        validation.reason === "invalid_schema" ? "invalid_tool_schema" : "invalid_arguments",
        validation.reason === "invalid_schema"
          ? "The MCP server published an invalid input schema."
          : "MCP tool arguments do not match the current input schema.",
        { issues: validation.issues },
      );
    }

    const invocation = await this.ports.invoke(route, input.arguments);
    if (!invocation.ok) {
      return reject(input, invocation.code, invocation.message, {
        ...(invocation.currentCatalogRevision
          ? { currentCatalogRevision: invocation.currentCatalogRevision }
          : {}),
      });
    }
    return {
      type: "mcp_call_result_v1",
      status: "completed",
      tool: input.tool,
      catalogRevision: route.catalogRevision,
      result: normalizeMcpCallResult(invocation.result),
    };
  }
}
