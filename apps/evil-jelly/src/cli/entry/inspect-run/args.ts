import type { CAC } from "cac";

export interface InspectCommandArgs {
  readonly kind: "inspect";
  readonly inspectSessionId?: string;
  readonly inspectJson: boolean;
  readonly inspectAllWorkspaces: boolean;
  readonly inspectTurnId?: string;
  readonly inspectSegment?: string;
  readonly inspectCallId?: string;
  readonly inspectDump: boolean;
  readonly inspectFull: boolean;
  readonly inspectTop?: number;
}

function failArgs(message: string): never {
  console.error(message);
  process.exit(1);
}

function resolveOptionalString(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim();
  return value.length > 0 ? value : undefined;
}

function resolvePositiveInteger(raw: unknown, option: string): number | undefined {
  const value = resolveOptionalString(raw);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    failArgs(`${option} requires a positive integer`);
  return parsed;
}

export function registerInspectArgs(cli: CAC): void {
  cli
    .command("inspect [sessionId]", "Inspect durable Session and Turn usage")
    .option("--json", "Print the versioned inspection projection as JSON")
    .option(
      "--turn <selector>",
      "Show one Turn's chronological token waterfall by displayed number or id",
    )
    .option(
      "--segment <address>",
      "Inspect one persisted waterfall segment or Initial context (N, N.M, or C1)",
    )
    .option("--call <id>", "Inspect one Tool call directly by ToolCall ID")
    .option("--dump", "Dump the complete persisted segment payload")
    .option("--full", "Show the full segment payload instead of a bounded preview")
    .option(
      "--top <number>",
      "Append the largest token-contributing segments across the selected scope",
    )
    .option("--all-workspaces", "Find the Session id across all Evil Jelly workspaces")
    .usage(
      "inspect [sessionId] [--turn <number-or-id>] [--segment <address> | --call <id>] [--dump | --json] [--full] [--top <number>] [--all-workspaces]",
    );
}

export function parseInspectArgs(
  args: readonly string[],
  options: Record<string, unknown>,
): InspectCommandArgs {
  const [rawSessionId, ...rest] = args;
  if (rest.length > 0) failArgs(`Unknown inspect argument: ${rest[0]}`);
  const inspectSessionId = resolveOptionalString(rawSessionId);
  const inspectAllWorkspaces = Boolean(options.allWorkspaces);
  const inspectTurnId = resolveOptionalString(options.turn);
  const inspectSegment = resolveOptionalString(options.segment);
  const inspectCallId = resolveOptionalString(options.call);
  const inspectDump = Boolean(options.dump);
  const inspectFull = Boolean(options.full);
  const inspectJson = Boolean(options.json);
  const inspectTop = resolvePositiveInteger(options.top, "--top");
  if (inspectAllWorkspaces && !inspectSessionId) {
    failArgs("--all-workspaces requires a sessionId");
  }
  if (inspectSegment && !inspectTurnId) failArgs("--segment requires --turn");
  if (inspectSegment && inspectCallId) failArgs("--segment cannot be combined with --call");
  if (inspectCallId && inspectTurnId) failArgs("--call cannot be combined with --turn");
  if (inspectDump && inspectJson) failArgs("--dump cannot be combined with --json");
  if ((inspectDump || inspectFull) && !inspectSegment && !inspectCallId) {
    failArgs("--dump and --full require --segment or --call");
  }
  if (inspectTop !== undefined && (inspectSegment || inspectCallId)) {
    failArgs("--top cannot be combined with --segment or --call");
  }
  return {
    kind: "inspect",
    ...(inspectSessionId ? { inspectSessionId } : {}),
    inspectJson,
    inspectAllWorkspaces,
    ...(inspectTurnId ? { inspectTurnId } : {}),
    ...(inspectSegment ? { inspectSegment } : {}),
    ...(inspectCallId ? { inspectCallId } : {}),
    inspectDump,
    inspectFull,
    ...(inspectTop !== undefined ? { inspectTop } : {}),
  };
}
