/**
 * CLI entry: initialize process-wide configuration and dispatch user-facing run modes.
 */

import { env, exitIfMissingOpenAIKey, loadEvilJellyEnv } from "../shared/configuration/env";
import { initSettings } from "../shared/configuration/settings";
import { createBackgroundHostBindings } from "./bindings/backgroundBindings";
import { createCliHostBindings } from "./bindings/cliBinding";
import { getCliVersion, parseCliArgs } from "./entry/args";
import { runAudit } from "./entry/audit-run/runAudit";
import { applyWorkspaceRootFromArgs } from "./entry/bootstrap";
import { runInit } from "./entry/init-run/runInit";
import { runMcpCommand } from "./entry/mcp-run/runMcp";
import { runUnified } from "./entry/unified-run/runUnified";
import { createOpenAIModelFromEnv } from "./model-composition/createModelFromEnv";

async function main() {
  const args = parseCliArgs();
  const appVersion = getCliVersion();
  if (args.kind === "init") {
    await runInit({
      apiKey: args.cliApiKey,
      baseUrl: args.initBaseUrl,
      modelId: args.initModelId,
      envFile: args.envFile,
    });
    process.exit(0);
  }
  applyWorkspaceRootFromArgs(args.workspace);
  initSettings(args.settings);
  if (args.kind === "mcp") {
    await runMcpCommand(args.mcpCommand);
    process.exit(0);
  }

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
    case "unified":
      await runUnified({
        startup: args.startup,
        headless: args.headless,
        autoAccept: args.autoAccept,
        review: args.review,
        appVersion,
        createModel: createOpenAIModelFromEnv,
        createBackgroundBindings: createBackgroundHostBindings,
        createInteractiveBindings: createCliHostBindings,
      });
      break;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
