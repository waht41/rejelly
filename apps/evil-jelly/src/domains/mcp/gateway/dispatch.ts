import {
  MCP_CONTRACT_LIMITS,
  type McpBoundRoute,
  type McpDispatchBinding,
  type McpReferenceInput,
  type McpReferenceResult,
  type McpReferenceUnavailableServer,
  type McpRequestInput,
  type McpRequestResult,
} from "../contracts";
import {
  createMcpChatGatewayToolDefinitions,
  type McpChatGatewayToolDefinitions,
} from "./gatewayTools";
import { type McpCallInvocationOutcome, McpCallPolicy } from "./mcpCallPolicy";

export interface McpGatewayCallDispatch {
  readonly binding: McpDispatchBinding;
  readonly invoke: (
    route: McpBoundRoute,
    argumentsValue: Record<string, unknown>,
  ) => Promise<McpCallInvocationOutcome>;
}

export interface McpGatewayDispatch extends McpGatewayCallDispatch {
  readonly reference: (input: McpReferenceInput) => Promise<McpReferenceResult>;
  readonly request: (input: McpRequestInput) => Promise<McpRequestResult>;
}

export type McpCallAuthorizationHandler = (
  route: McpBoundRoute,
  argumentsValue: Record<string, unknown>,
) => Promise<boolean>;

export type McpDispatchBindingFactory = (
  selectedServerIds?: readonly string[],
  authorizeCall?: McpCallAuthorizationHandler,
) => McpGatewayDispatch | Promise<McpGatewayDispatch>;

function matchScore(route: McpBoundRoute, terms: readonly string[]): number {
  const nativeName = route.identity.nativeToolName.toLocaleLowerCase();
  const serverId = route.identity.serverId.toLocaleLowerCase();
  const description = route.description.toLocaleLowerCase();
  let score = 0;
  for (const term of terms) {
    if (nativeName === term) score += 8;
    else if (nativeName.startsWith(term)) score += 5;
    else if (nativeName.includes(term)) score += 3;
    if (serverId === term) score += 4;
    else if (serverId.includes(term)) score += 2;
    if (description.includes(term)) score += 1;
  }
  return score;
}

export function referenceMcpTools(
  binding: McpDispatchBinding,
  input: McpReferenceInput,
): McpReferenceResult {
  const terms = input.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const listAll = terms.length === 1 && terms[0] === "*";
  const requestedServers = input.serverIds ? new Set(input.serverIds) : undefined;
  const matches: Array<{ route: McpBoundRoute & { readonly callable: boolean }; score: number }> =
    [];
  for (const server of binding.servers) {
    if (requestedServers && !requestedServers.has(server.serverId)) continue;
    if (server.status !== "ready" || !server.catalogRevision) continue;
    for (const tool of server.tools) {
      const identity = Object.freeze({
        serverId: server.serverId,
        nativeToolName: tool.nativeToolName,
      });
      const route = Object.freeze({
        identity,
        description: tool.description,
        inputSchema: tool.inputSchema,
        configFingerprint: server.configFingerprint,
        catalogRevision: server.catalogRevision,
        callable: binding.route(identity) !== undefined,
      });
      const score = listAll ? 1 : matchScore(route, terms);
      if (score > 0) matches.push({ route, score });
    }
  }
  const exactNameMatches =
    !listAll && terms.length === 1
      ? matches.filter(
          (match) => match.route.identity.nativeToolName.toLocaleLowerCase() === terms[0],
        )
      : [];
  const rankedMatches = exactNameMatches.length > 0 ? exactNameMatches : matches;
  rankedMatches.sort(
    (left, right) =>
      right.score - left.score ||
      left.route.identity.serverId.localeCompare(right.route.identity.serverId) ||
      left.route.identity.nativeToolName.localeCompare(right.route.identity.nativeToolName),
  );
  const maxResults = input.maxResults ?? Math.min(8, MCP_CONTRACT_LIMITS.referenceMaxResults);
  const returnedMatches = rankedMatches.slice(0, maxResults);
  const omittedToolIdentities = rankedMatches
    .slice(maxResults, maxResults + MCP_CONTRACT_LIMITS.referenceOmittedIdentities)
    .map((match) => match.route.identity);
  const unavailableServers: McpReferenceUnavailableServer[] = binding.servers
    .flatMap((server): McpReferenceUnavailableServer[] => {
      if (requestedServers && !requestedServers.has(server.serverId)) return [];
      if (server.status === "ready") return [];
      return [
        {
          serverId: server.serverId,
          status: server.status,
          ...(server.failure ? { failure: server.failure } : {}),
          suggestedAction:
            server.status === "disabled"
              ? "enable"
              : server.status === "untrusted" || server.status === "stopped"
                ? "request_access"
                : server.status === "pending"
                  ? "wait"
                  : "reload",
        },
      ];
    })
    .sort((left, right) => left.serverId.localeCompare(right.serverId));
  return Object.freeze({
    type: "mcp_reference_v1",
    matchedCount: rankedMatches.length,
    matches: Object.freeze(returnedMatches.map((match) => match.route)),
    ...(omittedToolIdentities.length > 0
      ? { omittedToolIdentities: Object.freeze(omittedToolIdentities) }
      : {}),
    ...(unavailableServers.length > 0
      ? { unavailableServers: Object.freeze(unavailableServers) }
      : {}),
  });
}

/** Create one tool batch whose handlers are permanently bound to one model dispatch. */
export function createMcpGatewayToolsForDispatch(
  dispatch: McpGatewayDispatch,
): McpChatGatewayToolDefinitions {
  return createMcpChatGatewayToolDefinitions({
    reference: dispatch.reference,
    request: dispatch.request,
    callPolicy: new McpCallPolicy({
      resolveRoute: (identity) => dispatch.binding.route(identity),
      invoke: dispatch.invoke,
    }),
  });
}

const EMPTY_MCP_BINDING: McpDispatchBinding = Object.freeze({
  bindingId: "mcp-dispatch-unavailable",
  generation: 0,
  servers: Object.freeze([]),
  route: () => undefined,
});

/** Keeps the provider tool surface stable even when no MCP runtime is configured. */
export function createUnavailableMcpDispatch(): McpGatewayDispatch {
  return Object.freeze({
    binding: EMPTY_MCP_BINDING,
    reference: async (input: McpReferenceInput) => referenceMcpTools(EMPTY_MCP_BINDING, input),
    request: async (input: McpRequestInput) => ({
      type: "mcp_request_v1" as const,
      serverId: input.serverId,
      status: "unavailable" as const,
      code: "runtime_unavailable" as const,
      message: "No MCP runtime is available for this dispatch.",
    }),
    invoke: async () => ({
      ok: false as const,
      code: "tool_unavailable" as const,
      message: "No MCP runtime is available for this dispatch.",
    }),
  });
}
