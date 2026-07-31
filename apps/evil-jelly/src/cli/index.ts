/**
 * CLI entry: parse args, dispatch headless commands, and start the interactive run loop.
 */

import { loadMockReplayFromTraceId } from "../features/testing/mockFromTrace";
import {
  createOpenAIModelFromEnv,
  env,
  exitIfMissingOpenAIKey,
  loadEvilJellyEnv,
} from "../shared/config";
import { initSettings } from "../shared/settings";
import { getCliVersion, parseCliArgs } from "./app/args";
import { applyWorkspaceRootFromArgs } from "./app/bootstrap";
import { runAuditCommand, runHeadlessUnifiedCommand, runInitCommand } from "./app/commands";
import { resolveInitialSession } from "./app/resume";
import { runInteractiveLoop } from "./app/runLoop";
import { loadStartupSnapshot } from "./app/snapshot";
import { createCliHostBindings } from "./bindings/cliBinding";
import { enqueueLineInput } from "./bindings/promptQueue";

export type {
  EvilJellyHostBindings,
  HostChoiceOption,
  HostChoiceView,
} from "../shared/types";
export { runEvilJellyHost } from "./app/host/runHost";

async function main() {
  const args = parseCliArgs();
  const appVersion = getCliVersion();
  if (args.kind === "init") {
    await runInitCommand(args.cliApiKey, args.initBaseUrl, args.initModelId);
    process.exit(0);
  }
  applyWorkspaceRootFromArgs(args.workspace);
  initSettings(args.settings);

  loadEvilJellyEnv({ cliApiKey: args.cliApiKey });

  switch (args.kind) {
    case "audit":
      exitIfMissingOpenAIKey();
      await runAuditCommand(args);
      process.exit(process.exitCode ?? 0);
      break;
    case "run":
      break;
  }

  if (args.startup.kind !== "mock") {
    exitIfMissingOpenAIKey();
  }

  if (args.headless) {
    await runHeadlessUnifiedCommand(args);
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
