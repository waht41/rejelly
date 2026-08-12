import { env } from "../../shared/configuration/env";
import { createOpenAIModelFromEnv } from "../model-composition/createModelFromEnv";
import type { ParsedRunArgs } from "./args";
import { createBackgroundHostBindings } from "./host/cliStubBindings";
import { runDirectUnified } from "./host/runDirectUnified";

export async function runHeadlessUnifiedCommand(args: ParsedRunArgs): Promise<void> {
  const seedInput = args.startup.kind === "fresh" ? args.startup.seedInput : undefined;
  if (!seedInput || seedInput.trim().length === 0) {
    console.error("--headless direct UnifiedAgent mode requires --input <text>");
    process.exit(1);
  }
  const model = createOpenAIModelFromEnv();
  await runDirectUnified(createBackgroundHostBindings({ autoAcceptWrite: args.autoAccept }), {
    model,
    userInput: seedInput,
    enableReview: args.review || env.REJELLY_ENABLE_REVIEW,
  });
}
