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
import { newTraceId, type SessionBudget } from "../../../services/session/sessionStore";
import { registerRunAbort } from "../../../services/stop/runControl";
import { withAbort } from "../../../services/stop/withAbort";
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
  /** Restored top-level conversation history seeded into the agent on resume. */
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
    seedHistory,
    seedBudget,
  } = options;
  const enableSnapshot = enableSnapshotOpt ?? (snapshot != null ? true : undefined);
  // One traceId per run segment. A logical session may span several of these across resumes;
  // session.id (below) is what groups them in devtool.
  const traceId = newTraceId();
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
          seedHistory,
          seedBudget,
          isolateSessionState: options.isolateSessionState,
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
  } catch (error) {
    if (isAbortError(error) || wasAbortedByRunSignal(error, runAbortController.signal)) {
      bindings.logSystemEvent("\nRun interrupted by user.\n");
      return;
    }
    bindings.logSystemEvent(`\nRun failed: ${formatRunFailure(error)}\n`);
  } finally {
    unregisterRunAbort();
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
