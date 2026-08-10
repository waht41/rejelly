/**
 * Runs CLI root agents under @rejelly/core.
 */

import {
  type AgentSnapshot,
  augmentAgent,
  isAbortError,
  type Message,
  type ModelAdapter,
} from "@rejelly/core";
import type { ReviewOptions } from "@rejelly/core/debugger";
import {
  SKILL_RUNTIME_PROVIDER_KEY,
  type SkillRuntimeSnapshot,
} from "../../../features/skills/contracts";
import { buildSkillAwareUserMessage } from "../../../features/skills/explicitSkillReferences";
import {
  buildConfiguredSkillRuntimeSnapshot,
  formatSkillRuntimeStartupSummary,
} from "../../../features/skills/skillRuntimeSnapshot";
import { UnifiedAgent } from "../../../features/unified/UnifiedAgent";
import { setBinding } from "../../../services/binding/hostBindings";
import { LazySessionRecorder } from "../../../services/session/lazySessionRecorder";
import {
  openSessionRecorder,
  type SessionRecorder,
} from "../../../services/session/sessionRecorder";
import type { SessionBudget } from "../../../services/session/sessionStore";
import { registerRunAbort } from "../../../services/stop/runControl";
import { withAbort } from "../../../services/stop/withAbort";
import { getWorkspaceFsPolicy } from "../../../shared/fs-policy/workspace-fs-policy";
import { generateTraceId } from "../../../shared/lib/traceId";
import type { EvilJellyHostBindings } from "../../../shared/types";
import { MainCliAgent } from "../../../shell/MainCliAgent";
import { runWithReview } from "./runWithReview";

export interface RunEvilJellyHostOptions {
  model: ModelAdapter;
  /** Enable Review exporter with default endpoint or custom options. */
  enableReview?: boolean | ReviewOptions;
  /**
   * Injected root snapshot (e.g. from restoreSnapshot + Review trace). When set, runWith restores context before the root agent runs.
   * Defaults enableSnapshot to true so replay/cache semantics match a restore run.
   */
  snapshot?: AgentSnapshot;
  /**
   * Pass-through to runWith. If omitted and snapshot is set, defaults to true (required in production for injection).
   */
  enableSnapshot?: boolean;
  /** Durable session id for local persistence / resume (distinct from the run traceId). */
  sessionId?: string;
  /**
   * New sessions defer file creation until their first durable event. Resumed sessions open
   * eagerly so writer locking and interrupted-turn recovery happen before accepting input.
   */
  sessionStartMode?: "new" | "resumed";
  /** Restored active model context seeded into the agent on resume. */
  seedContext?: Message[];
  /** @deprecated Compatibility alias; new callers should pass seedContext. */
  seedHistory?: Message[];
  /** Cumulative usage carried back from a resumed session, used as the /status base. */
  seedBudget?: SessionBudget;
  /**
   * MCP clients seeded as root providers (key `mcp:<id>`), read in-agent via expectResource.
   * Connected once at the run-loop boundary and reused across segments; the framework borrows
   * them (never closes), so disposal stays with the caller.
   */
  mcpProviders?: Record<string, unknown>;
  /** Borrowed process-lifetime loose Skill snapshot, reused across run segments. */
  skillSnapshot?: SkillRuntimeSnapshot;
  /**
   * Source trace id when this run replays a mock model (--mock). Tagged onto trace
   * attributes so devtool can tell mock replays (no real LLM calls, zero tokens) apart.
   */
  mockSourceTraceId?: string;
  /** Disable durable session reads/writes for replay-only runs. */
  isolateSessionState?: boolean;
  /** Session V2 writer configuration. Required whenever a durable sessionId is supplied. */
  sessionV2?: {
    enabled: true;
    appVersion: string;
    sessionsRoot?: string;
    blobRoot?: string;
  };
}

export interface RunDirectUnifiedOptions {
  model: ModelAdapter;
  userInput: string;
  history?: Message[];
  /** Enable Review exporter with default endpoint or custom options. */
  enableReview?: boolean | ReviewOptions;
}

function formatRunFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wasAbortedByRunSignal(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted &&
    error instanceof Error &&
    (error.name === "AbortError" || error.message.includes("aborted"))
  );
}

async function openRunSessionRecorder(
  options: RunEvilJellyHostOptions,
  traceId: string,
): Promise<SessionRecorder | undefined> {
  const { model, sessionId, sessionV2 } = options;
  if (!sessionId || options.isolateSessionState) {
    return undefined;
  }
  if (!sessionV2?.enabled) {
    throw new Error("Session V2 configuration is required for durable session execution");
  }
  if (!options.sessionStartMode) {
    throw new Error("Session start mode is required for durable session execution");
  }
  const recorderOptions = {
    workspaceRoot: getWorkspaceFsPolicy().getRoot(),
    sessionId,
    traceId,
    originator: "evil-jelly-cli",
    appVersion: sessionV2.appVersion,
    modelId: model.id,
    ...(model.provider ? { provider: model.provider } : {}),
    cwd: process.cwd(),
    ...(sessionV2.sessionsRoot ? { sessionsRoot: sessionV2.sessionsRoot } : {}),
    ...(sessionV2.blobRoot ? { blobRoot: sessionV2.blobRoot } : {}),
  };
  const openRecorder = () => openSessionRecorder(recorderOptions);
  return options.sessionStartMode === "new"
    ? new LazySessionRecorder(sessionId, traceId, openRecorder)
    : openRecorder();
}

async function endRunSegment(
  recorder: SessionRecorder | undefined,
  input: Parameters<SessionRecorder["endSegment"]>[0],
): Promise<void> {
  if (!recorder || recorder.ended) {
    return;
  }
  await recorder.endSegment(input);
}

async function endRunSegmentBestEffort(
  recorder: SessionRecorder | undefined,
  input: Parameters<SessionRecorder["endSegment"]>[0],
  bindings: EvilJellyHostBindings,
): Promise<void> {
  try {
    await endRunSegment(recorder, input);
  } catch (error) {
    bindings.logSystemEvent(`\nSession close failed: ${formatRunFailure(error)}\n`);
  }
}

async function closeRunSessionRecorder(
  recorder: SessionRecorder | undefined,
  bindings: EvilJellyHostBindings,
): Promise<void> {
  try {
    await recorder?.close();
  } catch (error) {
    bindings.logSystemEvent(`\nSession writer close failed: ${formatRunFailure(error)}\n`);
  }
}

/**
 * Starts one root run. Multi-turn control flow lives inside the agent via reborn().
 * Does not call process.exit - close resources in the caller after this resolves.
 */
export async function runEvilJellyHost(
  bindings: EvilJellyHostBindings,
  options: RunEvilJellyHostOptions,
): Promise<void> {
  const {
    model,
    snapshot,
    enableSnapshot: enableSnapshotOpt,
    sessionId,
    seedContext,
    seedHistory,
    seedBudget,
  } = options;
  const enableSnapshot = enableSnapshotOpt ?? (snapshot != null ? true : undefined);
  const providers = {
    ...(options.mcpProviders ?? {}),
    ...(options.skillSnapshot ? { [SKILL_RUNTIME_PROVIDER_KEY]: options.skillSnapshot } : {}),
  };
  // One traceId per run segment. A logical session may span several of these across resumes;
  // session.id (below) is what groups them in devtool.
  const traceId = generateTraceId();
  const recorder = await openRunSessionRecorder(options, traceId);
  const runAbortController = new AbortController();
  // Ctrl+C routes here: abort the whole run so the cancel signal reaches the
  // agent tree + teardown and the trace closes before exit.
  const unregisterRunAbort = registerRunAbort((reason) => {
    if (!runAbortController.signal.aborted) {
      runAbortController.abort(new Error(reason));
    }
  });
  try {
    await runWithReview({
      model,
      enableReview: options.enableReview,
      run: async () =>
        // Spread the whole host surface: a hand-picked field list silently drops
        // newly added (especially optional) bindings, e.g. showSessionBanner.
        MainCliAgent({
          ...bindings,
          sessionId,
          traceId,
          seedContext,
          seedHistory,
          seedBudget,
          sessionBlobRoot: options.sessionV2?.blobRoot,
          isolateSessionState: options.isolateSessionState,
          sessionRecorder: recorder,
        }),
      runWithOptions: {
        snapshot,
        enableSnapshot,
        signal: runAbortController.signal,
        providers: Object.keys(providers).length > 0 ? providers : undefined,
        trace: {
          traceId,
          attributes: {
            "devtool.display_name": "evil-jelly mainCLi",
            ...(sessionId ? { "session.id": sessionId } : {}),
            ...(options.mockSourceTraceId
              ? { "mock.source_trace_id": options.mockSourceTraceId }
              : {}),
            ...(options.skillSnapshot
              ? {
                  "evil_jelly.skills.count": options.skillSnapshot.catalog.size,
                  "evil_jelly.skills.catalog_fingerprint":
                    options.skillSnapshot.catalog.fingerprint,
                }
              : {}),
          },
        },
      },
    });
    await endRunSegment(recorder, { status: "completed", reason: "exit" });
  } catch (error) {
    if (isAbortError(error) || wasAbortedByRunSignal(error, runAbortController.signal)) {
      await endRunSegmentBestEffort(recorder, { status: "interrupted", reason: "abort" }, bindings);
      bindings.logSystemEvent("\nRun interrupted by user.\n");
      return;
    }
    await endRunSegmentBestEffort(
      recorder,
      {
        status: "error",
        reason: "error",
        errorMessage: formatRunFailure(error),
      },
      bindings,
    );
    bindings.logSystemEvent(`\nRun failed: ${formatRunFailure(error)}\n`);
  } finally {
    unregisterRunAbort();
    await closeRunSessionRecorder(recorder, bindings);
  }
}

/** Runs UnifiedAgent once in headless mode (no router / no Ink prompt loop). */
export async function runDirectUnified(
  bindings: EvilJellyHostBindings,
  options: RunDirectUnifiedOptions,
): Promise<void> {
  const { model, userInput, history } = options;
  const traceId = generateTraceId();
  try {
    const skillRuntime = await buildConfiguredSkillRuntimeSnapshot();
    const skillSummary = formatSkillRuntimeStartupSummary(skillRuntime);
    if (skillSummary) {
      bindings.logSystemEvent(`${skillSummary}\n`);
    }
    const UnifiedAgentWithAbort = augmentAgent(UnifiedAgent, [withAbort()]);
    await runWithReview({
      model,
      enableReview: options.enableReview,
      run: async () => {
        await setBinding(bindings);
        const message = await buildSkillAwareUserMessage(
          { text: userInput },
          skillRuntime.snapshot,
        );
        bindings.logUserMessage(userInput);
        const result = await UnifiedAgentWithAbort({ message, history });
        bindings.logAssistantMessage(result.reply);
      },
      runWithOptions: {
        providers: { [SKILL_RUNTIME_PROVIDER_KEY]: skillRuntime.snapshot },
        trace: {
          traceId,
          attributes: {
            "devtool.display_name": "evil-jelly unified (headless)",
            "evil_jelly.headless": true,
            "evil_jelly.skills.count": skillRuntime.snapshot.catalog.size,
            "evil_jelly.skills.catalog_fingerprint": skillRuntime.snapshot.catalog.fingerprint,
          },
        },
      },
    });
  } catch (error) {
    bindings.logSystemEvent(`\nRun failed: ${formatRunFailure(error)}\n`);
  }
}
