/** Runs one interactive Unified session segment under @rejelly/core. */

import { type AgentSnapshot, isAbortError, type Message, type ModelAdapter } from "@rejelly/core";
import type { ReviewOptions } from "@rejelly/core/debugger";
import type { McpSessionControl } from "../../../../domains/mcp/management/sessionControl";
import { LazySessionRecorder } from "../../../../domains/session/recorder/lazySessionRecorder";
import {
  openSessionRecorder,
  type SessionRecorder,
} from "../../../../domains/session/recorder/sessionRecorder";
import { materializeMessageHistory } from "../../../../domains/session/repository/sessionMessageMaterializer";
import type { SessionBudget } from "../../../../domains/session/repository/sessionStore";
import {
  SKILL_RUNTIME_PROVIDER_KEY,
  type SkillRuntimeSnapshot,
} from "../../../../domains/skills/agent/skillRuntime";
import type { ConversationAgentProps } from "../../../../features/unified/conversationRun";
import { getWorkspaceFsPolicy } from "../../../../shared/fs-policy/workspace-fs-policy";
import type { EvilJellyBindings } from "../../../../shared/host/bindings";
import { runWithReview } from "../../../runtime/runWithReview";
import { generateTraceId } from "../../../runtime/traceId";
import { MainCliAgent, type MainCliAgentProps } from "../../../unified-conversation/MainCliAgent";
import type { InteractiveRunControl } from "./runControl";

export interface RunEvilJellyHostOptions {
  runControl: InteractiveRunControl;
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
  /** Cumulative usage carried back from a resumed session, used as the /status base. */
  seedBudget?: SessionBudget;
  /** Session-level MCP selection recovered independently of compacted model history. */
  seedMcpSelection?: readonly string[];
  /** Resolve non-secret token metadata at submit time. */
  resolveMcpUserInput?: MainCliAgentProps["resolveMcpUserInput"];
  /**
   * MCP clients seeded as root providers (key `mcp:<id>`), read in-agent via expectResource.
   * Connected once at the run-loop boundary and reused across segments; the framework borrows
   * them (never closes), so disposal stays with the caller.
   */
  mcpProviders?: Record<string, unknown>;
  /** Captures one immutable MCP binding for every model boundary. */
  mcpBindingFactory?: ConversationAgentProps["mcpBindingFactory"];
  /** Interactive lifecycle over the process-owned MCP runtime. */
  mcpSessionControl?: McpSessionControl;
  /** Borrowed process-lifetime loose Skill snapshot, reused across run segments. */
  skillSnapshot?: SkillRuntimeSnapshot;
  /**
   * Source trace id when this run replays a mock model (--mock). Tagged onto trace
   * attributes so devtool can tell mock replays (no real LLM calls, zero tokens) apart.
   */
  mockSourceTraceId?: string;
  /** Disable durable session reads/writes for replay-only runs. */
  isolateSessionState?: boolean;
  /** Durable Session writer configuration. Required whenever a durable sessionId is supplied. */
  session?: {
    enabled: true;
    appVersion: string;
    sessionsRoot?: string;
    blobRoot?: string;
  };
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
  const { model, sessionId, session } = options;
  if (!sessionId || options.isolateSessionState) {
    return undefined;
  }
  if (!session?.enabled) {
    throw new Error("Session configuration is required for durable session execution");
  }
  if (!options.sessionStartMode) {
    throw new Error("Session start mode is required for durable session execution");
  }
  const recorderOptions = {
    workspaceRoot: getWorkspaceFsPolicy().getRoot(),
    sessionId,
    traceId,
    originator: "evil-jelly-cli",
    appVersion: session.appVersion,
    modelId: model.id,
    ...(model.provider ? { provider: model.provider } : {}),
    cwd: process.cwd(),
    ...(session.sessionsRoot ? { sessionsRoot: session.sessionsRoot } : {}),
    ...(session.blobRoot ? { blobRoot: session.blobRoot } : {}),
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
  bindings: EvilJellyBindings,
): Promise<void> {
  try {
    await endRunSegment(recorder, input);
  } catch (error) {
    bindings.logSystemEvent(`\nSession close failed: ${formatRunFailure(error)}\n`);
  }
}

async function closeRunSessionRecorder(
  recorder: SessionRecorder | undefined,
  bindings: EvilJellyBindings,
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
  bindings: EvilJellyBindings,
  options: RunEvilJellyHostOptions,
): Promise<void> {
  const {
    model,
    snapshot,
    enableSnapshot: enableSnapshotOpt,
    sessionId,
    seedContext,
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
  const unregisterRunAbort = options.runControl.segment.registerAbort((reason) => {
    if (!runAbortController.signal.aborted) {
      runAbortController.abort(new Error(reason));
    }
  });
  try {
    const preparedSeedContext = seedContext
      ? await materializeMessageHistory(
          seedContext,
          options.session?.blobRoot ? { blobRoot: options.session.blobRoot } : {},
        )
      : undefined;
    await runWithReview({
      model,
      enableReview: options.enableReview,
      run: async () =>
        // Spread the whole host surface: a hand-picked field list silently drops
        // newly added (especially optional) bindings, e.g. showSessionBanner.
        MainCliAgent({
          ...bindings,
          runLoopControl: options.runControl.loop,
          sessionId,
          traceId,
          seedContext: preparedSeedContext,
          seedBudget,
          seedMcpSelection: options.seedMcpSelection,
          resolveMcpUserInput: options.resolveMcpUserInput,
          sessionBlobRoot: options.session?.blobRoot,
          isolateSessionState: options.isolateSessionState,
          sessionRecorder: recorder,
          mcpBindingFactory: options.mcpBindingFactory,
          mcpSessionControl: options.mcpSessionControl,
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
