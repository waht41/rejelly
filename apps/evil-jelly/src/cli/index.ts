/**
 * CLI entry: initialize process-wide configuration and dispatch user-facing run modes.
 */

import { startupTimeline } from "../shared/startupTimeline";
import { getCliVersion, parseCliArgs } from "./entry/args";
import { createInteractiveRunControl } from "./entry/unified-run/interactive/runControl";
import type { RunUnifiedOptions } from "./entry/unified-run/runUnified";

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
  let startProxy: () => Promise<void>;
  try {
    startProxy = loadEvilJellyEnv({
      cliApiKey: args.cliApiKey,
      envFile: args.envFile,
    }).startProxy;
    startupTimeline.mark("env_ready");
  } catch (error) {
    // A misnamed or incomplete profile is a user-facing config error, so print the line rather
    // than the stack the top-level catch would show.
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const startProfiledProxy = (): Promise<void> => {
    const ready = startProxy().then(() => startupTimeline.mark("proxy_ready"));
    // Interactive startup may not await this until after Ink mounts. Observe rejection now to
    // prevent an unhandled-rejection event while preserving it for the later await.
    void ready.catch(() => undefined);
    return ready;
  };

  switch (args.kind) {
    case "audit": {
      const [{ runAudit }, { createBackgroundHostBindings }, { createOpenAIModelFromEnv }] =
        await Promise.all([
          import("./entry/audit-run/runAudit"),
          import("./bindings/backgroundBindings"),
          import("./model-composition/createModelFromEnv"),
        ]);
      const proxyReady = startProfiledProxy();
      exitIfMissingOpenAIKey();
      await proxyReady;
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
      startupTimeline.mark("unified_imports_started");
      const profiledImport = async <T>(
        readyMilestone: string,
        importer: () => Promise<T>,
      ): Promise<T> => {
        const imported = await importer();
        startupTimeline.mark(readyMilestone);
        return imported;
      };
      const runUnifiedImport = profiledImport(
        "unified_run_module_ready",
        () => import("./entry/unified-run/runUnified"),
      );
      const backgroundBindingsImport = profiledImport(
        "background_bindings_module_ready",
        () => import("./bindings/backgroundBindings"),
      );
      const cliBindingsImport = profiledImport(
        "cli_bindings_module_ready",
        () => import("./bindings/cliBinding"),
      );
      const modelCompositionImport = profiledImport(
        "model_composition_module_ready",
        () => import("./model-composition/createModelFromEnv"),
      );
      const unifiedImports = Promise.all([
        runUnifiedImport,
        backgroundBindingsImport,
        cliBindingsImport,
        modelCompositionImport,
      ]);
      // The shell may own the foreground while another import fails. Observe the aggregate now;
      // the later await still receives and reports the original rejection.
      void unifiedImports.catch(() => undefined);

      let preparedInteractiveShell: RunUnifiedOptions["preparedInteractiveShell"];
      let shellOwnershipTransferred = false;
      try {
        if (!args.headless) {
          const { createCliHostBindings } = await cliBindingsImport;
          const runControl = createInteractiveRunControl();
          preparedInteractiveShell = {
            ...createCliHostBindings({
              version: getCliVersion(),
              seedInput: args.startup.seedInput,
              reviewCliFlag: args.review,
              runControl,
            }),
            runControl,
          };
          startupTimeline.mark("ink_mounted");
        }

        const [
          { runUnified },
          { createBackgroundHostBindings },
          { createCliHostBindings },
          { createOpenAIModelFromEnv },
        ] = await unifiedImports;
        startupTimeline.mark("unified_modules_ready");
        const proxyReady = startProfiledProxy();
        shellOwnershipTransferred = preparedInteractiveShell !== undefined;
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
          proxyReady,
          ...(preparedInteractiveShell ? { preparedInteractiveShell } : {}),
        });
      } finally {
        if (!shellOwnershipTransferred) {
          preparedInteractiveShell?.dispose();
        }
      }
      break;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
