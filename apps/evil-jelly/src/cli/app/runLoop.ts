import type { AgentSnapshot, Message, ModelAdapter } from "@rejelly/core";
import { qualifiedSkillName } from "../../features/skills/contracts";
import {
  buildConfiguredSkillRuntimeSnapshot,
  formatSkillRuntimeStartupSummary,
} from "../../features/skills/skillRuntimeSnapshot";
import {
  takePendingExit,
  takePendingNewSession,
  takePendingResume,
} from "../../services/session/resumeControl";
import {
  generateSessionId,
  resumeSession,
  type SessionBudget,
} from "../../services/session/sessionStore";
import { getWorkspaceFsPolicy } from "../../shared/fs-policy/workspace-fs-policy";
import type { TranscriptItem } from "../../shared/transcript";
import type { EvilJellyHostBindings } from "../../shared/types";
import { connectMcpProviders } from "../../tools/mcpServerKit";
import { type RunEvilJellyHostOptions, runEvilJellyHost } from "./host/runHost";
import {
  buildLegacyResumeSeed,
  buildSessionResumeSeed,
  hydrateResumeSeed,
  type SessionResumeSeed,
} from "./resume";

export interface RunInteractiveLoopParams {
  bindings: EvilJellyHostBindings;
  model: ModelAdapter;
  enableReview: boolean;
  snapshot: AgentSnapshot | undefined;
  sessionId?: string;
  resumeSeed?: SessionResumeSeed;
  /** @deprecated Compatibility fields; prefer resumeSeed. */
  seedContext?: Message[];
  /** @deprecated Compatibility alias; prefer resumeSeed. */
  seedHistory?: Message[];
  /** @deprecated Compatibility field; prefer resumeSeed. */
  seedTranscript?: TranscriptItem[];
  /** @deprecated Compatibility field; prefer resumeSeed. */
  seedTranscriptTotalTurns?: number;
  /** @deprecated Compatibility field; prefer resumeSeed. */
  seedBudget?: SessionBudget;
  /** Source trace id when the run replays a mock model (--mock); tags trace attributes. */
  mockSourceTraceId?: string;
  /** Keep replay sessions away from durable local session state. */
  isolateSessionState?: boolean;
  /** Session V2 writer configuration. */
  sessionV2?: RunEvilJellyHostOptions["sessionV2"];
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

type RunLoopIntent =
  | { type: "exit" }
  | { type: "new_session" }
  | { type: "resume"; sessionId: string }
  | { type: "none" };

function normalizeInitialResumeSeed(
  params: RunInteractiveLoopParams,
): SessionResumeSeed | undefined {
  if (params.resumeSeed) {
    return params.resumeSeed;
  }
  const activeContext = params.seedContext ?? params.seedHistory;
  if (
    activeContext === undefined &&
    params.seedTranscript === undefined &&
    params.seedBudget === undefined
  ) {
    return undefined;
  }
  const legacySeed = buildLegacyResumeSeed(activeContext ?? [], {
    totalTurns: params.seedTranscriptTotalTurns,
    budget: params.seedBudget,
  });
  return {
    ...legacySeed,
    ...(params.seedTranscript ? { transcript: params.seedTranscript } : {}),
  };
}

function takeRunLoopIntent(): RunLoopIntent {
  if (takePendingExit()) {
    return { type: "exit" };
  }
  if (takePendingNewSession()) {
    return { type: "new_session" };
  }
  const sessionId = takePendingResume();
  return sessionId ? { type: "resume", sessionId } : { type: "none" };
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
  sessionV2: RunEvilJellyHostOptions["sessionV2"],
): Promise<{ state: ResumedSessionState; isSameSession: boolean } | undefined> {
  if (!sessionV2) {
    throw new Error("Session V2 configuration is required to resume a durable session");
  }
  const record = await resumeSession(getWorkspaceFsPolicy().getRoot(), requestedSessionId, {
    originator: "evil-jelly-cli",
    appVersion: sessionV2.appVersion,
    ...(sessionV2?.sessionsRoot ? { sessionsRoot: sessionV2.sessionsRoot } : {}),
    ...(sessionV2?.blobRoot ? { blobRoot: sessionV2.blobRoot } : {}),
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
    model,
    enableReview,
    mockSourceTraceId,
    isolateSessionState = false,
    sessionV2,
  } = params;
  const initialResumeSeed = normalizeInitialResumeSeed(params);
  let state: InteractiveSessionState = {
    sessionId: params.sessionId,
    snapshot: params.snapshot,
    resumeSeed: initialResumeSeed,
    sessionStartMode: initialResumeSeed ? "resumed" : "new",
  };

  // Legacy callers historically hydrated the view themselves unless they supplied
  // seedTranscript. The new resumeSeed contract owns both context and display hydration.
  if (state.resumeSeed && (params.resumeSeed || params.seedTranscript)) {
    hydrateResumeSeed(bindings, state.sessionId ?? "(ephemeral)", state.resumeSeed);
  }

  // Connect optional MCP servers (e.g. devtool introspection) once, above the run loop, so the
  // connection is reused across resume segments. Best-effort: empty when disabled/unreachable.
  // The framework borrows these via runWith({ providers }); disposal stays here (finally).
  const { providers: mcpProviders, dispose: disposeMcp } = await connectMcpProviders();
  try {
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
    // the current run, queues a target via resumeControl, and we restart with the loaded history.
    while (true) {
      await runEvilJellyHost(bindings, {
        model,
        enableReview,
        snapshot: state.snapshot,
        sessionId: isolateSessionState ? undefined : state.sessionId,
        sessionStartMode: state.sessionStartMode,
        seedContext: state.resumeSeed?.activeContext,
        seedBudget: state.resumeSeed?.budget,
        mcpProviders,
        skillSnapshot: skillRuntime.snapshot,
        mockSourceTraceId,
        isolateSessionState,
        sessionV2,
      });

      const intent = takeRunLoopIntent();
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
          const resumed = await loadResumedSession(state, intent.sessionId, sessionV2);
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
    await disposeMcp();
  }
}
