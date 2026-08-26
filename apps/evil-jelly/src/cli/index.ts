/**
 * CLI entry: initialize process-wide configuration and dispatch user-facing run modes.
 */

import { startupTimeline } from "../shared/startupTimeline";
import { getCliVersion, parseCliArgs } from "./entry/args";

startupTimeline.mark("cli_module_ready");

async function main() {
  const args = parseCliArgs();
  startupTimeline.mark("cli_args_parsed");
  if (args.kind === "init") {
    const { runInit } = await import("./entry/init-run/runInit");
    await runInit({
      apiKey: args.cliApiKey,
      baseUrl: args.initBaseUrl,
      modelId: args.initModelId,
      envFile: args.envFile,
    });
    process.exit(0);
  }

  const [{ applyWorkspaceRootFromArgs }, { initSettings }] = await Promise.all([
    import("./entry/bootstrap"),
    import("../shared/configuration/settings"),
  ]);
  applyWorkspaceRootFromArgs(args.workspace);
  initSettings(args.settings);
  startupTimeline.mark("workspace_ready");
  if (args.kind === "mcp") {
    const { runMcpCommand } = await import("./entry/mcp-run/runMcp");
    await runMcpCommand(args.mcpCommand);
    process.exit(0);
  }
  if (args.kind === "skills") {
    const { runSkillCommand } = await import("./entry/skill-run/runSkill");
    await runSkillCommand(args.skillCommand);
    process.exit(0);
  }

  const { env, exitIfMissingOpenAIKey, loadEvilJellyEnv } = await import(
    "../shared/configuration/env"
  );
  try {
    loadEvilJellyEnv({ cliApiKey: args.cliApiKey, envFile: args.envFile });
    startupTimeline.mark("env_ready");
  } catch (error) {
    // A misnamed or incomplete profile is a user-facing config error, so print the line rather
    // than the stack the top-level catch would show.
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  switch (args.kind) {
    case "audit": {
      const [{ runAudit }, { createBackgroundHostBindings }, { createOpenAIModelFromEnv }] =
        await Promise.all([
          import("./entry/audit-run/runAudit"),
          import("./bindings/backgroundBindings"),
          import("./model-composition/createModelFromEnv"),
        ]);
      exitIfMissingOpenAIKey();
      await runAudit({
        model: createOpenAIModelFromEnv(),
        bindings: createBackgroundHostBindings(),
        enableReview: args.review || env.REJELLY_ENABLE_REVIEW,
        auditOptions: args.auditOptions,
      });
      process.exit(process.exitCode ?? 0);
      break;
    }
    case "unified": {
      const [
        { runUnified },
        { createBackgroundHostBindings },
        { createCliHostBindings },
        { createOpenAIModelFromEnv },
      ] = await Promise.all([
        import("./entry/unified-run/runUnified"),
        import("./bindings/backgroundBindings"),
        import("./bindings/cliBinding"),
        import("./model-composition/createModelFromEnv"),
      ]);
      startupTimeline.mark("unified_modules_ready");
      await runUnified({
        startup: args.startup,
        headless: args.headless,
        autoAccept: args.autoAccept,
        review: args.review,
        appVersion: getCliVersion(),
        devtool: args.devtool,
        createModel: createOpenAIModelFromEnv,
        createBackgroundBindings: createBackgroundHostBindings,
        createInteractiveBindings: createCliHostBindings,
      });
      break;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
