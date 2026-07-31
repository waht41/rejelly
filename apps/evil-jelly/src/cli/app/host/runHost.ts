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
import { UnifiedAgent } from "../../../features/unified/UnifiedAgent";
import { setBinding } from "../../../services/binding/hostBindings";
import {
  openSessionRecorder,
  type SessionRecorder,
} from "../../../services/session/sessionRecorder";
import { newTraceId, type SessionBudget } from "../../../services/session/sessionStore";
import { registerRunAbort } from "../../../services/stop/runControl";
import { withAbort } from "../../../services/stop/withAbort";
import { getWorkspaceFsPolicy } from "../../../shared/fs-policy/workspace-fs-policy";
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
  /** Restored active model context seeded into the agent on resume. */
  seedContext?: Message[];
  /** @deprecated Compatibility alias while Session V1 remains the default. */
  seedHistory?: Message[];
  /** Cumulative usage carried back from a resumed session, used as the /status base. */
  seedBudget?: SessionBudget;
  /**
   * MCP clients seeded as root providers (key `mcp:<id>`), read in-agent via expectResource.
   * Connected once at the run-loop boundary and reused across segments; the framework borrows
   * them (never closes), so disposal stays with the caller.
   */
  mcpProviders?: Record<string, unknown>;
  /**
   * Source trace id when this run replays a mock model (--mock). Tagged onto trace
   * attributes so devtool can tell mock replays (no real LLM calls, zero tokens) apart.
   */
  mockSourceTraceId?: string;
  /** Disable durable session reads/writes for replay-only runs. */
  isolateSessionState?: boolean;
  /**
   * Internal Phase 4 switch. The CLI composition root deliberately leaves this unset until the
   * mixed V1/V2 listing and migration facade lands in Phase 5.
   */
  sessionV2?: {
    enabled: true;
    appVersion: string;
    sessionsRoot?: string;
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
  if (!sessionV2?.enabled || !sessionId || options.isolateSessionState) {
    return undefined;
  }
  return openSessionRecorder({
    workspaceRoot: getWorkspaceFsPolicy().getRoot(),
    sessionId,
    traceId,
    originator: "evil-jelly-cli",
    appVersion: sessionV2.appVersion,
    modelId: model.id,
    ...(model.provider ? { provider: model.provider } : {}),
    cwd: process.cwd(),
    ...(sessionV2.sessionsRoot ? { sessionsRoot: sessionV2.sessionsRoot } : {}),
  });
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
  // One traceId per run segment. A logical session may span several of these across resumes;
  // session.id (below) is what groups them in devtool.
  const traceId = newTraceId();
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
          isolateSessionState: options.isolateSessionState,
          sessionRecorder: recorder,
        }),
      runWithOptions: {
        snapshot,
        enableSnapshot,
        signal: runAbortController.signal,
        providers: options.mcpProviders,
        trace: {
          traceId,
          attributes: {
            "devtool.display_name": "evil-jelly mainCLi",
            ...(sessionId ? { "session.id": sessionId } : {}),
            ...(options.mockSourceTraceId
              ? { "mock.source_trace_id": options.mockSourceTraceId }
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
  const traceId = newTraceId();
  try {
    const UnifiedAgentWithAbort = augmentAgent(UnifiedAgent, [withAbort()]);
    await runWithReview({
      model,
      enableReview: options.enableReview,
      run: async () => {
        await setBinding(bindings);
        bindings.logUserMessage(userInput);
        const result = await UnifiedAgentWithAbort({ userInput, history });
        bindings.logAssistantMessage(result.reply);
      },
      runWithOptions: {
        trace: {
          traceId,
          attributes: {
            "devtool.display_name": "evil-jelly unified (headless)",
            "evil_jelly.headless": true,
          },
        },
      },
    });
  } catch (error) {
    bindings.logSystemEvent(`\nRun failed: ${formatRunFailure(error)}\n`);
  }
}
