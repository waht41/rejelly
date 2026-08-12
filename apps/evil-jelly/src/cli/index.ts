/**
 * CLI entry: parse args, dispatch headless commands, and start the interactive run loop.
 */

import { loadMockReplayFromTraceId } from "../features/replay/mock/mockFromTrace";
import { env, exitIfMissingOpenAIKey, loadEvilJellyEnv } from "../shared/configuration/env";
import { initSettings } from "../shared/configuration/settings";
import { getCliVersion, parseCliArgs } from "./app/args";
import { applyWorkspaceRootFromArgs } from "./app/bootstrap";
import { createBackgroundHostBindings } from "./app/host/cliStubBindings";
import { runInitCommand } from "./app/initCommand";
import { createCliHostBindings } from "./bindings/cliBinding";
import { enqueueLineInput } from "./bindings/lineInputQueue";
import { runAudit } from "./entry/audit-run/runAudit";
import { runHeadless } from "./entry/unified-run/headless/runHeadless";
import { resolveInitialSession } from "./entry/unified-run/interactive/resume";
import { runInteractiveLoop } from "./entry/unified-run/interactive/runLoop";
import { loadStartupSnapshot } from "./entry/unified-run/interactive/startupSnapshot";
import { createOpenAIModelFromEnv } from "./model-composition/createModelFromEnv";

export type { EvilJellyBindings } from "../shared/host/bindings";
export type {
  PromptChoiceOption,
  PromptChoiceView,
} from "../shared/host/inputBindings";
export { runEvilJellyHost } from "./entry/unified-run/interactive/runSegment";

async function main() {
  const args = parseCliArgs();
  const appVersion = getCliVersion();
  if (args.kind === "init") {
    await runInitCommand({
      apiKey: args.cliApiKey,
      baseUrl: args.initBaseUrl,
      modelId: args.initModelId,
      envFile: args.envFile,
    });
    process.exit(0);
  }
  applyWorkspaceRootFromArgs(args.workspace);
  initSettings(args.settings);

  try {
    loadEvilJellyEnv({ cliApiKey: args.cliApiKey, envFile: args.envFile });
  } catch (error) {
    // A misnamed profile or a profile that would leak a key across endpoints: user-facing
    // config errors, so print the line rather than the stack the top-level catch would show.
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  switch (args.kind) {
    case "audit":
      exitIfMissingOpenAIKey();
      await runAudit({
        model: createOpenAIModelFromEnv(),
        bindings: createBackgroundHostBindings(),
        enableReview: args.review || env.REJELLY_ENABLE_REVIEW,
        auditOptions: args.auditOptions,
      });
      process.exit(process.exitCode ?? 0);
      break;
    case "run":
      break;
  }

  if (args.startup.kind !== "mock") {
    exitIfMissingOpenAIKey();
  }

  if (args.headless) {
    const seedInput = args.startup.kind === "fresh" ? args.startup.seedInput : undefined;
    if (!seedInput || seedInput.trim().length === 0) {
      console.error("--headless direct UnifiedAgent mode requires --input <text>");
      process.exit(1);
    }
    await runHeadless(createBackgroundHostBindings({ autoAcceptWrite: args.autoAccept }), {
      model: createOpenAIModelFromEnv(),
      userInput: seedInput,
      enableReview: args.review || env.REJELLY_ENABLE_REVIEW,
    });
    process.exit(process.exitCode ?? 0);
  }

  const { sessionId, resumeSeed } = await resolveInitialSession({
    resume: args.startup.kind === "resume",
    resumeSessionId: args.startup.kind === "resume" ? args.startup.sessionId : undefined,
    appVersion,
  });

  const { bindings, dispose } = createCliHostBindings({
    version: appVersion,
    seedInput: args.startup.seedInput,
    reviewCliFlag: args.review,
  });
  const mockTraceId = args.startup.kind === "mock" ? args.startup.traceId : undefined;
  const mockReplay = mockTraceId ? await loadMockReplayFromTraceId(mockTraceId) : undefined;
  if (mockReplay) {
    bindings.logSystemEvent(
      `Mock replay loaded from trace ${mockTraceId} (${mockReplay.sequenceLength} model turn(s)).\n`,
    );
    if (args.startup.kind === "mock" && args.startup.enqueueTraceInputs) {
      for (const input of mockReplay.inputs) {
        enqueueLineInput({ text: input });
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
      args.startup.kind === "snapshot" ? args.startup.traceId : undefined,
      bindings,
    ));
  const model = mockReplay?.model ?? createOpenAIModelFromEnv();
  try {
    await runInteractiveLoop({
      bindings,
      model,
      enableReview: args.review || env.REJELLY_ENABLE_REVIEW,
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
