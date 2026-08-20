import type { CAC } from "cac";
import type { McpServerSettings } from "../../../domains/mcp/configuration/configuration";
import type { McpValueSource } from "../../../domains/mcp/contracts";

function failArgs(message: string): never {
  console.error(message);
  process.exit(1);
}

function resolveOptionalString(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim();
  return value.length > 0 ? value : undefined;
}

export type McpReadScope = "effective" | "user" | "project";
export type McpWriteScope = Exclude<McpReadScope, "effective">;

export type McpManagementCommand =
  | { readonly action: "list"; readonly scope: McpReadScope }
  | { readonly action: "get"; readonly serverId: string; readonly scope: McpReadScope }
  | {
      readonly action: "add";
      readonly serverId: string;
      readonly scope: McpWriteScope;
      readonly settings: McpServerSettings;
    }
  | {
      readonly action: "remove" | "enable" | "disable";
      readonly serverId: string;
      readonly scope: McpWriteScope;
    };

export interface McpCommandArgs {
  readonly kind: "mcp";
  readonly mcpCommand: McpManagementCommand;
}

export function registerMcpArgs(cli: CAC): void {
  cli
    .command("mcp [...mcpArgs]", "Manage MCP server settings")
    .usage("mcp list|get|add|remove|enable|disable [serverId] [options]")
    .option("--scope <scope>", "user, project, or effective (read commands only)")
    .option("--url <url>", "add: Streamable HTTP endpoint")
    .option("--cwd <path>", "add stdio: working directory (default: workspace root)")
    .option(
      "--server-env <KEY=env:NAME|KEY=value:TEXT>",
      "add stdio: environment value source (repeatable)",
    )
    .option("--header <KEY=env:NAME|KEY=value:TEXT>", "add HTTP: header value source (repeatable)");
}

function requiredArgument(raw: string | undefined, label: string): string {
  const value = raw?.trim();
  if (!value) failArgs(`mcp ${label} is required.`);
  return value;
}

function parseReadScope(raw: unknown): McpReadScope {
  const value = resolveOptionalString(raw) ?? "effective";
  if (value === "effective" || value === "user" || value === "project") return value;
  failArgs(`--scope must be user, project, or effective; received "${value}".`);
}

function parseWriteScope(raw: unknown): McpWriteScope {
  const value = resolveOptionalString(raw);
  if (value === "user" || value === "project") return value;
  if (value === "effective") {
    failArgs(
      "Mutating MCP commands require --scope user or --scope project; effective is read-only.",
    );
  }
  failArgs("Mutating MCP commands require an explicit --scope user or --scope project.");
}

function optionValues(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === false) return [];
  return (Array.isArray(raw) ? raw : [raw]).map(String);
}

function parseValueSources(
  raw: unknown,
  flag: "--server-env" | "--header",
): Record<string, McpValueSource> {
  const result: Record<string, McpValueSource> = {};
  for (const assignment of optionValues(raw)) {
    const separator = assignment.indexOf("=");
    const name = assignment.slice(0, separator).trim();
    const source = separator >= 0 ? assignment.slice(separator + 1) : "";
    if (!name || !source) {
      failArgs(`${flag} expects KEY=env:NAME or KEY=value:TEXT.`);
    }
    if (result[name] !== undefined) failArgs(`${flag} contains duplicate key "${name}".`);
    if (source.startsWith("env:") && source.length > 4) {
      result[name] = { fromEnv: source.slice(4) };
    } else if (source.startsWith("value:")) {
      result[name] = { value: source.slice(6) };
    } else {
      failArgs(`${flag} expects KEY=env:NAME or KEY=value:TEXT.`);
    }
  }
  return result;
}

function assertNoExtraArgs(args: readonly string[], action: string): void {
  if (args.length > 0) failArgs(`Unknown mcp ${action} argument: ${args[0]}`);
}

function parseAddSettings(
  command: readonly string[],
  options: Record<string, unknown>,
): McpServerSettings {
  const url = resolveOptionalString(options.url);
  const cwd = resolveOptionalString(options.cwd);
  const environment = parseValueSources(options.serverEnv, "--server-env");
  const headers = parseValueSources(options.header, "--header");
  if (url !== undefined) {
    if (command.length > 0) failArgs("mcp add accepts either --url or a stdio command, not both.");
    if (cwd !== undefined || Object.keys(environment).length > 0) {
      failArgs("--cwd/--server-env apply only to stdio MCP servers.");
    }
    return {
      transport: {
        type: "streamableHttp",
        url,
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
      },
    };
  }
  if (Object.keys(headers).length > 0) failArgs("--header requires --url.");
  const executable = command[0]?.trim();
  if (!executable) {
    failArgs("mcp add requires --url <url> or a stdio command after the server id.");
  }
  return {
    transport: {
      type: "stdio",
      command: executable,
      ...(command.length > 1 ? { args: command.slice(1) } : {}),
      ...(cwd === undefined ? {} : { cwd }),
      ...(Object.keys(environment).length === 0 ? {} : { env: environment }),
    },
  };
}

export function parseMcpArgs(
  args: readonly string[],
  options: Record<string, unknown>,
): McpCommandArgs {
  const [rawAction = "list", rawServerId, ...rest] = args;
  const trailingCommand = optionValues(options["--"]);
  switch (rawAction) {
    case "list":
      if (rawServerId !== undefined) failArgs(`Unknown mcp list argument: ${rawServerId}`);
      assertNoExtraArgs(trailingCommand, "list");
      return { kind: "mcp", mcpCommand: { action: "list", scope: parseReadScope(options.scope) } };
    case "get": {
      const serverId = requiredArgument(rawServerId, "get serverId");
      assertNoExtraArgs([...rest, ...trailingCommand], "get");
      return {
        kind: "mcp",
        mcpCommand: { action: "get", serverId, scope: parseReadScope(options.scope) },
      };
    }
    case "add": {
      const serverId = requiredArgument(rawServerId, "add serverId");
      return {
        kind: "mcp",
        mcpCommand: {
          action: "add",
          serverId,
          scope: parseWriteScope(options.scope),
          settings: parseAddSettings([...rest, ...trailingCommand], options),
        },
      };
    }
    case "remove":
    case "enable":
    case "disable": {
      const serverId = requiredArgument(rawServerId, `${rawAction} serverId`);
      assertNoExtraArgs([...rest, ...trailingCommand], rawAction);
      return {
        kind: "mcp",
        mcpCommand: {
          action: rawAction,
          serverId,
          scope: parseWriteScope(options.scope),
        },
      };
    }
    default:
      failArgs(
        `Unknown mcp action "${rawAction}". Allowed: list, get, add, remove, enable, disable.`,
      );
  }
}
