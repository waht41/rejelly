import type { ToolConfirmationHandler } from "../../../shared/host/toolConfirmationBindings";
import {
  createSessionMcpState,
  type SessionMcpState,
} from "../../../shared/model/mcp/sessionMcpState";
import type { McpRequestInput } from "../contracts";
import type { McpDispatchBindingFactory } from "../gateway/dispatch";
import { mcpToolGrantForRoute, mcpToolGrantMatchesRoute } from "../permissions";
import { requestMcpAccess } from "./requestAccess";
import type { McpSessionControl } from "./sessionControl";

export interface McpChatAuthorizationState {
  readonly get: () => SessionMcpState;
  readonly commitSelection: (next: SessionMcpState) => Promise<void>;
  readonly commitToolGrants: (next: SessionMcpState) => Promise<void>;
}

/** Bind Session authorization state and host approvals to a model-dispatch factory. */
export function createAuthorizedMcpBindingFactory(options: {
  readonly bindingFactory: McpDispatchBindingFactory;
  readonly control?: McpSessionControl;
  readonly confirmTool: ToolConfirmationHandler;
  readonly state: McpChatAuthorizationState;
  readonly effectiveSelectedServerIds: () => readonly string[];
}): McpDispatchBindingFactory {
  return async () => {
    const dispatch = await options.bindingFactory(
      options.effectiveSelectedServerIds(),
      async (route, argumentsValue) => {
        const current = options.state.get();
        if (
          current.toolGrants.some((grant) => mcpToolGrantMatchesRoute(grant, route)) ||
          options.control?.isPersistentToolAllowed(route)
        ) {
          return true;
        }
        const grant = mcpToolGrantForRoute(route);
        const decision = await options.confirmTool({
          type: "mcp_call",
          tool: route.identity,
          configFingerprint: grant.configFingerprint,
          toolSchemaFingerprint: grant.toolSchemaFingerprint,
          arguments: argumentsValue,
        });
        if (decision.action !== "accept") return false;
        if (decision.scope === "session") {
          await options.state.commitToolGrants(
            createSessionMcpState({
              ...current,
              toolGrants: [
                ...current.toolGrants.filter(
                  (existing) =>
                    existing.serverId !== grant.serverId ||
                    existing.nativeToolName !== grant.nativeToolName,
                ),
                grant,
              ],
            }),
          );
        } else if (decision.scope === "always") {
          await options.control?.grantPersistentToolAccess(grant);
        }
        return true;
      },
    );
    return Object.freeze({
      ...dispatch,
      request: (input: McpRequestInput) =>
        requestMcpAccess(input, {
          control: options.control,
          selectedServerIds: () => options.state.get().selectedServerIds,
          approve: async (proposal) => {
            const source =
              proposal.source.kind === "dynamic"
                ? `dynamic:${proposal.source.sourceId}`
                : proposal.source.kind;
            const decision = await options.confirmTool({
              type: "mcp_access",
              serverId: proposal.serverId,
              source,
              configFingerprint: proposal.configFingerprint,
              requiresTrust: proposal.requiresTrust,
              ...(proposal.reason ? { reason: proposal.reason } : {}),
            });
            if (decision.action !== "accept") return false;
            return decision.scope === "always" ? "always" : "session";
          },
          commitSelection: async (selectedServerIds) =>
            options.state.commitSelection(
              createSessionMcpState({ ...options.state.get(), selectedServerIds }),
            ),
        }),
    });
  };
}
