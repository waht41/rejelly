/** CLI argument composition for the evil binary (cac). */

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import cac from "cac";
import type { CommonParsedArgs } from "./argsSupport";
import { failArgs, resolveOptionalPath, resolveOptionalString } from "./argsSupport";
import {
  type AuditCommandArgs,
  auditSettingsOverrides,
  hasAuditOnlyArgs,
  parseAuditArgs,
  registerAuditArgs,
} from "./audit-run/args";
import { type InitCommandArgs, parseInitArgs, registerInitArgs } from "./init-run/args";
import { type McpCommandArgs, parseMcpArgs, registerMcpArgs } from "./mcp-run/args";
import {
  parseUnifiedRunArgs,
  registerUnifiedRunArgs,
  type UnifiedRunCommandArgs,
} from "./unified-run/args";

export type ParsedInitArgs = CommonParsedArgs & InitCommandArgs;
export type ParsedAuditArgs = CommonParsedArgs & AuditCommandArgs;
export type ParsedUnifiedArgs = CommonParsedArgs & UnifiedRunCommandArgs;
export type ParsedMcpArgs = CommonParsedArgs & McpCommandArgs;
export type ParsedEvilJellyArgs =
  | ParsedInitArgs
  | ParsedAuditArgs
  | ParsedMcpArgs
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

cli
  .usage("[command] [options]")
  .option("--api-key <key>", "OPENAI_API_KEY override for this command")
  .option(
    "--env <name|path>",
    "Env profile to load above the shell: a name resolves to ~/.evil-jelly/<name>.env",
  )
  .option(
    "--workspace <dir>",
    "Workspace root for config and agent tools; defaults to the current directory",
  )
  .option("--review", "Enable review trace exporter");

registerUnifiedRunArgs(cli);
registerInitArgs(cli);
registerAuditArgs(cli);
registerMcpArgs(cli);

cli
  .help((sections) =>
    sections.map((section) => ({
      ...section,
      // CAC models --no-* flags as default=true booleans and prints that parser default next to
      // the negated flag. Hiding the implementation detail avoids implying the disabling flag is
      // active by default.
      body: section.body.replace(/^(\s+--no-\S+.*?) \(default: true\)$/gm, "$1"),
    })),
  )
  .version(getCliVersion());

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
  if (options.cwd !== undefined) {
    throw new Error("Unknown option `--cwd`; use `--workspace <dir>` instead");
  }

  const common: CommonParsedArgs = {
    cliApiKey: resolveOptionalString(options.apiKey),
    envFile: resolveOptionalString(options.env),
    review: Boolean(options.review),
    workspace: resolveOptionalPath(options.workspace),
    settings: {
      ...auditSettingsOverrides(options),
    },
  };

  if (options.help || options.version) {
    process.exit(0);
  }

  const commandName = cli.matchedCommandName ?? cli.matchedCommand?.name ?? "";
  if (commandName === "init") {
    return { ...common, ...parseInitArgs(options) };
  }
  if (commandName === "audit") {
    if (options.devtool) {
      failArgs(
        "--devtool is not supported by audit; configure a server with use.audit.exposure=always instead",
      );
    }
    return { ...common, ...parseAuditArgs(args, options) };
  }
  if (commandName === "mcp") {
    return { ...common, ...parseMcpArgs(args, options) };
  }
  if (hasAuditOnlyArgs(options)) {
    failArgs(
      "--family/--only-actionable/--max-seeds/--ledger-gc-days/--no-ledger-gc/--doc/--code require the audit subcommand",
    );
  }
  const runArgs = parseUnifiedRunArgs(args, options);
  return {
    ...common,
    ...runArgs,
    review: common.review || runArgs.startup.kind === "snapshot",
  };
}
