/** CLI argument composition for the evil binary (cac). */

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import cac, { type Command } from "cac";
import {
  type ProfileSelector,
  parseProfileSelectors,
} from "../../shared/profile/startup/selection";
import type { CommonParsedArgs } from "./argsSupport";
import { failArgs, resolveOptionalPath, resolveOptionalString } from "./argsSupport";
import {
  type AuditCommandArgs,
  auditSettingsOverrides,
  parseAuditArgs,
  registerAuditArgs,
} from "./audit-run/args";
import { type InitCommandArgs, parseInitArgs, registerInitArgs } from "./init-run/args";
import { type InspectCommandArgs, parseInspectArgs, registerInspectArgs } from "./inspect-run/args";
import {
  extractMcpAddCommand,
  type McpCommandArgs,
  parseMcpArgs,
  registerMcpArgs,
} from "./mcp-run/args";
import { parseSkillsArgs, registerSkillsArgs, type SkillsCommandArgs } from "./skill-run/args";
import {
  parseUnifiedRunArgs,
  registerUnifiedRunArgs,
  type UnifiedRunCommandArgs,
} from "./unified-run/args";

export type ParsedInitArgs = CommonParsedArgs & InitCommandArgs;
export type ParsedAuditArgs = CommonParsedArgs & AuditCommandArgs;
export type ParsedUnifiedArgs = CommonParsedArgs & UnifiedRunCommandArgs;
export type ParsedMcpArgs = CommonParsedArgs & McpCommandArgs;
export type ParsedSkillsArgs = CommonParsedArgs & SkillsCommandArgs;
export type ParsedInspectArgs = CommonParsedArgs & InspectCommandArgs;
export type ParsedEvilJellyArgs =
  | ParsedInitArgs
  | ParsedAuditArgs
  | ParsedInspectArgs
  | ParsedMcpArgs
  | ParsedSkillsArgs
  | ParsedUnifiedArgs;

export function getCliVersion(): string {
  // Source lives at src/cli/entry/args.ts, while tsup bundles it into dist/cli/index.js.
  for (const relativePath of ["../../package.json", "../../../package.json"]) {
    try {
      const pkgPath = fileURLToPath(new URL(relativePath, import.meta.url));
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === "@rejelly/evil-jelly" && pkg.version) {
        return pkg.version;
      }
    } catch {
      // Try the other supported layout.
    }
  }
  return "0.0.0";
}

const cli = cac("evil");

function customizeHelpSections(
  sections: Array<{ readonly title?: string; readonly body: string }>,
): Array<{ readonly title?: string; readonly body: string }> {
  return sections.map((section) => ({
    ...section,
    // CAC models --no-* flags as default=true booleans. Hide that parser implementation detail.
    body: section.body.replace(/^(\s+--no-\S+.*?) \(default: true\)$/gm, "$1"),
  }));
}

cli.usage("[command] [options]");

function registerSharedCommandArgs(commands: {
  readonly unified: Command;
  readonly init: Command;
  readonly audit: Command;
  readonly inspect: Command;
  readonly mcp: Command;
  readonly skills: Command;
}): void {
  const { unified, init, audit, inspect, mcp, skills } = commands;

  for (const command of [unified, init, audit]) {
    command
      .option("--api-key <key>", "OPENAI_API_KEY override for this command")
      .option(
        "--env <name|path>",
        "Env profile above the shell: a name resolves to ~/.evil-jelly/<name>.env",
      );
  }

  for (const command of [unified, audit, inspect, mcp, skills]) {
    command.option(
      "--workspace <dir>",
      "Workspace root for config and agent tools; defaults to the current directory",
    );
  }

  for (const command of [unified, audit]) {
    command
      .option(
        "--profile <selector>",
        "Profile view(s), comma-separated; available: startup, startup:bootstrap, startup:imports, startup:ink",
      )
      .option("--review", "Enable review trace exporter");
  }
}

registerSharedCommandArgs({
  unified: registerUnifiedRunArgs(cli),
  init: registerInitArgs(cli),
  audit: registerAuditArgs(cli),
  inspect: registerInspectArgs(cli),
  mcp: registerMcpArgs(cli),
  skills: registerSkillsArgs(cli),
});

cli.help(customizeHelpSections).version(getCliVersion());

export function parseCliArgs(argv: string[] = process.argv): ParsedEvilJellyArgs {
  cli.unsetMatchedCommand();
  // `--` conventionally ends option parsing. If a package manager forwards it as the first
  // script argument, CAC intentionally ignores everything after it; without this guard an audit
  // invocation can therefore look like a bare command and accidentally launch interactive Ink.
  if (argv[2] === "--" && argv.length > 3) {
    failArgs(
      "Unexpected leading `--`: it stops Evil Jelly from parsing the following command. " +
        "When using pnpm, omit it (for example: `pnpm ... start --review audit ...`).",
    );
  }

  const { args, options } = cli.parse(argv, { run: false });
  const commandName = cli.matchedCommandName ?? cli.matchedCommand?.name ?? "";
  const rawMcpAddCommand = commandName === "mcp" ? extractMcpAddCommand(argv) : undefined;
  const matchedCommand = cli.matchedCommand;
  if (matchedCommand) {
    try {
      matchedCommand.checkUnknownOptions();
      matchedCommand.checkOptionValue();
      matchedCommand.checkRequiredArgs();
    } catch (error) {
      // Preserve the actionable separator guidance when an unseparated stdio command contains
      // flags that CAC would otherwise report as unknown Evil options.
      if (
        commandName === "mcp" &&
        args[0] === "add" &&
        options.url === undefined &&
        rawMcpAddCommand === undefined
      ) {
        parseMcpArgs(args, options, rawMcpAddCommand);
      }
      failArgs(error instanceof Error ? error.message : String(error));
    }
  }

  let profileSelectors: readonly ProfileSelector[] | undefined;
  const profileSelector = resolveOptionalString(options.profile);
  if (profileSelector !== undefined) {
    try {
      profileSelectors = parseProfileSelectors(profileSelector);
    } catch (error) {
      failArgs(error instanceof Error ? error.message : String(error));
    }
  }

  const common: CommonParsedArgs = {
    cliApiKey: resolveOptionalString(options.apiKey),
    envFile: resolveOptionalString(options.env),
    review: Boolean(options.review),
    workspace: resolveOptionalPath(options.workspace),
    profileSelectors,
    settings: {
      ...auditSettingsOverrides(options),
    },
  };

  if (options.help || options.version) {
    process.exit(0);
  }

  if (commandName === "init") {
    return { ...common, ...parseInitArgs(options) };
  }
  if (commandName === "audit") {
    return { ...common, ...parseAuditArgs(args, options) };
  }
  if (commandName === "inspect") {
    const inspect = parseInspectArgs(args, options);
    if (inspect.inspectAllWorkspaces && common.workspace) {
      failArgs("--all-workspaces cannot be combined with --workspace");
    }
    return { ...common, ...inspect };
  }
  if (commandName === "mcp") {
    return { ...common, ...parseMcpArgs(args, options, rawMcpAddCommand) };
  }
  if (commandName === "skills") {
    return { ...common, ...parseSkillsArgs(args) };
  }
  const runArgs = parseUnifiedRunArgs(args, options);
  return {
    ...common,
    ...runArgs,
    review: common.review || runArgs.startup.kind === "snapshot",
  };
}
