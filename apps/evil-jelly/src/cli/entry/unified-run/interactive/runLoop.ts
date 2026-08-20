import type { AgentSnapshot, ModelAdapter } from "@rejelly/core";
import {
  createDevtoolMcpDesiredServer,
  resolveMcpSettingsLayers,
} from "../../../../domains/mcp/configuration/configuration";
import { isMcpToolAllowed, type McpDesiredConfig } from "../../../../domains/mcp/contracts";
import type {
  McpSessionControl,
  McpSessionStatusRow,
} from "../../../../domains/mcp/management/sessionControl";
import {
  createMcpDispatchBindingFactory,
  createMcpRuntimeProviders,
} from "../../../../domains/mcp/mcpServerKit";
import { McpRuntimeManager } from "../../../../domains/mcp/runtime/runtimeManager";
import { SdkMcpRuntimeConnector } from "../../../../domains/mcp/runtime/sdkConnector";
import {
  generateSessionId,
  resumeSession,
} from "../../../../domains/session/repository/sessionStore";
import { qualifiedSkillName } from "../../../../domains/skills/definition/skillDefinition";
import {
  getEnvironmentValue,
  getReviewEndpointFromEnv,
} from "../../../../shared/configuration/env";
import { getSettings, invalidateSettingsCache } from "../../../../shared/configuration/settings";
import { getWorkspaceFsPolicy } from "../../../../shared/fs-policy/workspace-fs-policy";
import type { EvilJellyBindings } from "../../../../shared/host/bindings";
import { grantMcpWorkspaceTrust, readMcpTrustGrants } from "../../../../shared/mcp/trustRepository";
import { buildConfiguredSkillRuntimeSnapshot } from "../../../skill-runtime/configuredRuntime";
import { formatSkillRuntimeStartupSummary } from "../../../skill-runtime/startupSummary";
import { buildSessionResumeSeed, hydrateResumeSeed, type SessionResumeSeed } from "./resume";
import type { InteractiveRunControl } from "./runControl";
import { type RunEvilJellyHostOptions, runEvilJellyHost } from "./runSegment";

export interface RunInteractiveLoopParams {
  bindings: EvilJellyBindings;
  runControl: InteractiveRunControl;
  model: ModelAdapter;
  enableReview: boolean;
  snapshot: AgentSnapshot | undefined;
  sessionId?: string;
  resumeSeed?: SessionResumeSeed;
  /** Source trace id when the run replays a mock model (--mock); tags trace attributes. */
  mockSourceTraceId?: string;
  /** Keep replay sessions away from durable local session state. */
  isolateSessionState?: boolean;
  /** Durable Session writer configuration. */
  session?: RunEvilJellyHostOptions["session"];
}

interface InteractiveSessionState {
  sessionId: string | undefined;
  snapshot: AgentSnapshot | undefined;
  resumeSeed: SessionResumeSeed | undefined;
  sessionStartMode: "new" | "resumed";
}

interface ResumedSessionState extends InteractiveSessionState {
  sessionId: string;
  snapshot: undefined;
  resumeSeed: SessionResumeSeed;
}

function startNewSession(isolateSessionState: boolean): InteractiveSessionState {
  return {
    sessionId: isolateSessionState ? undefined : generateSessionId(),
    resumeSeed: undefined,
    sessionStartMode: "new",
    // A startup snapshot must not leak into a later logical session.
    snapshot: undefined,
  };
}

async function loadResumedSession(
  state: InteractiveSessionState,
  requestedSessionId: string,
  session: RunEvilJellyHostOptions["session"],
): Promise<{ state: ResumedSessionState; isSameSession: boolean } | undefined> {
  if (!session) {
    throw new Error("Session configuration is required to resume a durable session");
  }
  const record = await resumeSession(getWorkspaceFsPolicy().getRoot(), requestedSessionId, {
    originator: "evil-jelly-cli",
    appVersion: session.appVersion,
    ...(session.sessionsRoot ? { sessionsRoot: session.sessionsRoot } : {}),
    ...(session.blobRoot ? { blobRoot: session.blobRoot } : {}),
  });
  if (!record) {
    return undefined;
  }
  return {
    isSameSession: record.meta.id === state.sessionId,
    state: {
      sessionId: record.meta.id,
      resumeSeed: buildSessionResumeSeed(record),
      sessionStartMode: "resumed",
      // Resume reconstructs history; it must not inherit a startup snapshot.
      snapshot: undefined,
    },
  };
}

export async function runInteractiveLoop(params: RunInteractiveLoopParams): Promise<void> {
  const {
    bindings,
    runControl,
    model,
    enableReview,
    mockSourceTraceId,
    isolateSessionState = false,
    session,
  } = params;
  let state: InteractiveSessionState = {
    sessionId: params.sessionId,
    snapshot: params.snapshot,
    resumeSeed: params.resumeSeed,
    sessionStartMode: params.resumeSeed ? "resumed" : "new",
  };

  if (state.resumeSeed) {
    hydrateResumeSeed(bindings, state.sessionId ?? "(ephemeral)", state.resumeSeed);
  }

  // Connect optional MCP servers (e.g. devtool introspection) once, above the run loop, so the
  // connection is reused across resume segments. Best-effort: empty when disabled/unreachable.
  // The framework borrows these via runWith({ providers }); disposal stays here (finally).
  const workspaceRoot = getWorkspaceFsPolicy().getRoot();
  const resolveDesiredMcp = (): McpDesiredConfig => {
    const settings = getSettings();
    const dynamicMcpServers = settings.mcp.devtool
      ? [createDevtoolMcpDesiredServer(`${new URL(getReviewEndpointFromEnv()).origin}/mcp`)]
      : [];
    return resolveMcpSettingsLayers(settings.mcp, dynamicMcpServers);
  };
  const mcpRuntime = new McpRuntimeManager(
    new SdkMcpRuntimeConnector({
      workspaceRoot,
      resolveEnvironment: getEnvironmentValue,
    }),
  );
  let desiredMcp = resolveDesiredMcp();
  let trustGrants = readMcpTrustGrants(workspaceRoot);
  await mcpRuntime.reconcile(desiredMcp, trustGrants);
  const mcpProviders = createMcpRuntimeProviders(mcpRuntime);
  const mcpBindingFactory = createMcpDispatchBindingFactory(mcpRuntime, bindings.confirmTool);
  const publishMcpInventory = () =>
    bindings.setAvailableMcpServers?.(
      desiredMcp.servers
        .filter((server) => server.definition.use.chat.exposure !== "off")
        .map((server) => ({ serverId: server.id })),
    );
  const mcpSessionControl: McpSessionControl = {
    status: (selectedServerIds): readonly McpSessionStatusRow[] => {
      const selected = new Set(selectedServerIds);
      const runtimeById = new Map(
        mcpRuntime.getSnapshot().servers.map((server) => [server.serverId, server]),
      );
      return desiredMcp.servers.map((server) => {
        const runtime = runtimeById.get(server.id);
        const exposure = server.definition.use.chat.exposure;
        const isSelected = selected.has(server.id);
        return {
          serverId: server.id,
          source: server.source,
          exposure,
          selected: isSelected,
          routable:
            runtime?.status === "ready" &&
            exposure !== "off" &&
            (exposure === "always" || isSelected),
          connection: runtime?.status ?? "failed",
          toolCount:
            mcpRuntime
              .getCatalog(server.id)
              ?.tools.filter((tool) => isMcpToolAllowed(server.definition, "chat", tool.name))
              .length ?? 0,
          configFingerprint: runtime?.configFingerprint ?? "unavailable",
          ...(runtime?.error ? { error: runtime.error } : {}),
        };
      });
    },
    reload: async (serverId) => {
      invalidateSettingsCache();
      desiredMcp = resolveDesiredMcp();
      trustGrants = readMcpTrustGrants(workspaceRoot);
      await mcpRuntime.reconcile(desiredMcp, trustGrants);
      publishMcpInventory();
      await mcpRuntime.reload(serverId);
    },
    grantTrust: async (serverId) => {
      const server = desiredMcp.servers.find((candidate) => candidate.id === serverId);
      const runtime = mcpRuntime
        .getSnapshot()
        .servers.find((candidate) => candidate.serverId === serverId);
      if (!server || !runtime) throw new Error(`Unknown MCP server: ${serverId}`);
      if (server.source.kind !== "workspace") return;
      grantMcpWorkspaceTrust(workspaceRoot, {
        serverId,
        configFingerprint: runtime.configFingerprint,
      });
      trustGrants = readMcpTrustGrants(workspaceRoot);
      await mcpRuntime.reconcile(desiredMcp, trustGrants);
    },
  };
  const resolveMcpUserInput = (serverId: string) => {
    const state = mcpRuntime.getSnapshot().servers.find((server) => server.serverId === serverId);
    if (!state) return { status: "unavailable" as const };
    const status =
      state.status === "disabled"
        ? ("disabled" as const)
        : state.status === "untrusted"
          ? ("untrusted" as const)
          : ("selected" as const);
    return { status, configFingerprint: state.configFingerprint };
  };
  try {
    publishMcpInventory();
    const skillRuntime = await buildConfiguredSkillRuntimeSnapshot();
    bindings.setAvailableSkills?.(
      (skillRuntime.snapshot.catalog.entries ?? []).map((skill) => ({
        name: skill.name,
        qualifiedName: qualifiedSkillName(skill),
        scope: skill.origin.scope,
        description: skill.description,
        ...(skill.shortDescription ? { shortDescription: skill.shortDescription } : {}),
      })),
    );
    const skillSummary = formatSkillRuntimeStartupSummary(skillRuntime);
    if (skillSummary) {
      bindings.logSystemEvent(`${skillSummary}\n`);
    }
    // Outer loop: each iteration is one runWith segment (own traceId). A mid-session /resume ends
    // the current run, queues a loop intent, and we restart with the loaded history.
    while (true) {
      await runEvilJellyHost(bindings, {
        runControl,
        model,
        enableReview,
        snapshot: state.snapshot,
        sessionId: isolateSessionState ? undefined : state.sessionId,
        sessionStartMode: state.sessionStartMode,
        seedContext: state.resumeSeed?.activeContext,
        seedBudget: state.resumeSeed?.budget,
        seedMcpSelection: state.resumeSeed?.mcpSelection,
        mcpProviders,
        mcpBindingFactory,
        mcpSessionControl,
        resolveMcpUserInput,
        skillSnapshot: skillRuntime.snapshot,
        mockSourceTraceId,
        isolateSessionState,
        session,
      });

      const intent = runControl.loop.take();
      switch (intent.type) {
        case "exit":
        case "none":
          return;
        case "new_session": {
          state = startNewSession(isolateSessionState);
          bindings.logSystemEvent(
            isolateSessionState
              ? "Started new isolated mock session.\n"
              : `Started new session ${state.sessionId}.\n`,
          );
          break;
        }
        case "resume": {
          if (isolateSessionState) {
            bindings.logSystemEvent("Resume is disabled during mock replay.\n");
            return;
          }
          const resumed = await loadResumedSession(state, intent.sessionId, session);
          if (!resumed) {
            bindings.logSystemEvent(`Resume failed: session ${intent.sessionId} not found.\n`);
            return;
          }
          state = resumed.state;
          if (resumed.isSameSession) {
            // The conversation is already visible; reload context without duplicating scrollback.
            bindings.logSystemEvent(`Resumed session ${state.sessionId} (already current).\n`);
          } else {
            hydrateResumeSeed(bindings, resumed.state.sessionId, resumed.state.resumeSeed);
          }
          break;
        }
      }
    }
  } finally {
    await mcpRuntime.dispose();
  }
}
