import type { AgentSnapshot, ModelAdapter } from "@rejelly/core";
import type { McpDesiredServer } from "../../../../domains/mcp/contracts";
import { createSessionMemoryRuntime } from "../../../../domains/memory/runtime/sessionMemoryRuntime";
import { createPersistentMemoryService } from "../../../../domains/memory/service/persistentMemoryServiceImpl";
import {
  generateSessionId,
  resumeSession,
} from "../../../../domains/session/repository/sessionStore";
import { qualifiedSkillName } from "../../../../domains/skills/definition/skillDefinition";
import { getWorkspaceFsPolicy } from "../../../../shared/fs-policy/workspace-fs-policy";
import type { EvilJellyBindings } from "../../../../shared/host/bindings";
import { startupTimeline } from "../../../../shared/startupTimeline";
import { createMcpChatRuntime } from "../../../mcp-runtime/mcpChatRuntime";
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
  /** CLI/host overlays already normalized to the same desired-server contract as settings. */
  dynamicMcpServers?: readonly McpDesiredServer[];
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

  const workspaceRoot = getWorkspaceFsPolicy().getRoot();
  const mcp = await createMcpChatRuntime({
    workspaceRoot,
    bindings,
    dynamicServers: params.dynamicMcpServers,
  });
  startupTimeline.mark("mcp_ready");
  try {
    const skillRuntime = await buildConfiguredSkillRuntimeSnapshot();
    startupTimeline.mark("skills_ready");
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
      const memoryRuntime = await createSessionMemoryRuntime(
        createPersistentMemoryService({ workspaceRoot }),
      );
      startupTimeline.mark("memory_ready");
      for (const diagnostic of memoryRuntime.diagnostics) {
        bindings.logSystemEvent(`Memory warning: ${diagnostic}\n`);
      }
      await runEvilJellyHost(bindings, {
        runControl,
        model,
        enableReview,
        snapshot: state.snapshot,
        sessionId: isolateSessionState ? undefined : state.sessionId,
        sessionStartMode: state.sessionStartMode,
        seedContext: state.resumeSeed?.activeContext,
        seedBudget: state.resumeSeed?.budget,
        seedMcpState: state.resumeSeed?.mcp,
        mcpProviders: mcp.providers,
        mcpBindingFactory: mcp.bindingFactory,
        mcpSessionControl: mcp.sessionControl,
        resolveMcpUserInput: mcp.resolveUserInput,
        skillSnapshot: skillRuntime.snapshot,
        diagnoseSkills: buildConfiguredSkillRuntimeSnapshot,
        memoryRuntime,
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
    await mcp.dispose();
  }
}
