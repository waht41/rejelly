import type { ModelAdapter } from "@rejelly/core";
import { createDevtoolMcpDesiredServer } from "../../../domains/mcp/configuration/configuration";
import { loadMockReplayFromTraceId } from "../../../features/replay/mock/mockFromTrace";
import {
  env,
  exitIfMissingOpenAIKey,
  getReviewEndpointFromEnv,
} from "../../../shared/configuration/env";
import type { EvilJellyBindings } from "../../../shared/host/bindings";
import { textPromptInput } from "../../../shared/model/prompt/promptInput";
import { startupTimeline } from "../../../shared/startupTimeline";
import { enqueueMainInput } from "../../submission-dispatch/mainInputQueue";
import type { RunStartupArgs } from "./args";
import { runHeadless } from "./headless/runHeadless";
import { resolveInitialSession } from "./interactive/resume";
import { createInteractiveRunControl, type InteractiveRunControl } from "./interactive/runControl";
import { runInteractiveLoop } from "./interactive/runLoop";
import { loadStartupSnapshot } from "./interactive/startupSnapshot";

export interface RunUnifiedOptions {
  startup: RunStartupArgs;
  headless: boolean;
  autoAccept: boolean;
  review: boolean;
  appVersion: string;
  devtool: boolean;
  createModel: () => ModelAdapter;
  createBackgroundBindings: (options?: { autoAcceptWrite?: boolean }) => EvilJellyBindings;
  createInteractiveBindings: (options: {
    version: string;
    seedInput?: string;
    reviewCliFlag?: boolean;
    runControl: InteractiveRunControl;
  }) => {
    bindings: EvilJellyBindings;
    dispose: () => void;
  };
  /** Proxy dispatcher initialization started by the composition root after env resolution. */
  proxyReady: Promise<void>;
  /** Interactive shell mounted by the composition root while the remaining runtime imports. */
  preparedInteractiveShell?: {
    bindings: EvilJellyBindings;
    dispose: () => void;
    runControl: InteractiveRunControl;
  };
}

export async function runUnified(options: RunUnifiedOptions): Promise<void> {
  startupTimeline.mark("unified_run_entered");
  const { startup, appVersion } = options;
  const dynamicMcpServers = options.devtool
    ? [createDevtoolMcpDesiredServer(`${new URL(getReviewEndpointFromEnv()).origin}/mcp`)]
    : [];
  if (startup.kind !== "mock") {
    exitIfMissingOpenAIKey();
  }

  if (options.headless) {
    const seedInput = startup.kind === "fresh" ? startup.seedInput : undefined;
    if (!seedInput || seedInput.trim().length === 0) {
      console.error("--headless direct UnifiedAgent mode requires --input <text>");
      process.exit(1);
    }
    await options.proxyReady;
    await runHeadless(options.createBackgroundBindings({ autoAcceptWrite: options.autoAccept }), {
      model: options.createModel(),
      userInput: seedInput,
      enableReview: options.review || env.REJELLY_ENABLE_REVIEW,
    });
    process.exit(process.exitCode ?? 0);
  }

  let interactiveShell = options.preparedInteractiveShell;
  try {
    const { sessionId, resumeSeed } = await resolveInitialSession({
      resume: startup.kind === "resume",
      resumeSessionId: startup.kind === "resume" ? startup.sessionId : undefined,
      appVersion,
    });
    startupTimeline.mark("session_resolved");

    if (!interactiveShell) {
      const runControl = createInteractiveRunControl();
      interactiveShell = {
        ...options.createInteractiveBindings({
          version: appVersion,
          seedInput: startup.seedInput,
          reviewCliFlag: options.review,
          runControl,
        }),
        runControl,
      };
      startupTimeline.mark("ink_mounted");
    }
    const { bindings, runControl } = interactiveShell;
    const mockTraceId = startup.kind === "mock" ? startup.traceId : undefined;
    const mockReplay = mockTraceId ? await loadMockReplayFromTraceId(mockTraceId) : undefined;
    if (mockReplay) {
      bindings.logSystemEvent(
        `Mock replay loaded from trace ${mockTraceId} (${mockReplay.sequenceLength} model turn(s)).\n`,
      );
      if (startup.kind === "mock" && startup.enqueueTraceInputs) {
        for (const input of mockReplay.inputs) {
          enqueueMainInput(textPromptInput(input));
        }
        bindings.logSystemEvent(
          mockReplay.inputs.length > 0
            ? `Queued ${mockReplay.inputs.length} user input(s) from trace.\n`
            : "No user inputs found in trace; falling back to manual input.\n",
        );
      }
    }
    const snapshot =
      mockReplay?.snapshot ??
      (await loadStartupSnapshot(
        startup.kind === "snapshot" ? startup.traceId : undefined,
        bindings,
      ));
    const model = mockReplay?.model ?? options.createModel();
    await options.proxyReady;
    await runInteractiveLoop({
      bindings,
      runControl,
      model,
      enableReview: options.review || env.REJELLY_ENABLE_REVIEW,
      snapshot,
      sessionId,
      resumeSeed,
      mockSourceTraceId: mockReplay ? mockTraceId : undefined,
      isolateSessionState: Boolean(mockReplay),
      session: { enabled: true, appVersion },
      dynamicMcpServers,
    });
  } finally {
    interactiveShell?.dispose();
  }

  process.stdout.write("\n");
  process.exit(0);
}
