import type { ModelAdapter } from "@rejelly/core";
import { loadMockReplayFromTraceId } from "../../../features/replay/mock/mockFromTrace";
import { env, exitIfMissingOpenAIKey } from "../../../shared/configuration/env";
import type { EvilJellyBindings } from "../../../shared/host/bindings";
import { textPromptInput } from "../../../shared/model/prompt/promptInput";
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
}

export async function runUnified(options: RunUnifiedOptions): Promise<void> {
  const { startup, appVersion } = options;
  if (startup.kind !== "mock") {
    exitIfMissingOpenAIKey();
  }

  if (options.headless) {
    const seedInput = startup.kind === "fresh" ? startup.seedInput : undefined;
    if (!seedInput || seedInput.trim().length === 0) {
      console.error("--headless direct UnifiedAgent mode requires --input <text>");
      process.exit(1);
    }
    await runHeadless(options.createBackgroundBindings({ autoAcceptWrite: options.autoAccept }), {
      model: options.createModel(),
      userInput: seedInput,
      enableReview: options.review || env.REJELLY_ENABLE_REVIEW,
    });
    process.exit(process.exitCode ?? 0);
  }

  const { sessionId, resumeSeed } = await resolveInitialSession({
    resume: startup.kind === "resume",
    resumeSessionId: startup.kind === "resume" ? startup.sessionId : undefined,
    appVersion,
  });

  const runControl = createInteractiveRunControl();
  const { bindings, dispose } = options.createInteractiveBindings({
    version: appVersion,
    seedInput: startup.seedInput,
    reviewCliFlag: options.review,
    runControl,
  });
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
  try {
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
      sessionV2: { enabled: true, appVersion },
    });
  } finally {
    dispose();
  }

  process.stdout.write("\n");
  process.exit(0);
}
