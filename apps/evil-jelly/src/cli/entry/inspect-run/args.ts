import type { CAC } from "cac";

export interface InspectCommandArgs {
  readonly kind: "inspect";
  readonly inspectSessionId?: string;
  readonly inspectJson: boolean;
  readonly inspectAllWorkspaces: boolean;
  readonly inspectTurnId?: string;
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

export function registerInspectArgs(cli: CAC): void {
  cli
    .command("inspect [sessionId]", "Inspect durable Session and Turn usage")
    .option("--json", "Print the versioned inspection projection as JSON")
    .option(
      "--turn <number|id>",
      "Show one Turn's chronological token waterfall by displayed number or id",
    )
    .option("--all-workspaces", "Find the Session id across all Evil Jelly workspaces")
    .usage("inspect [sessionId] [--turn <number|id>] [--json] [--all-workspaces]");
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
  if (inspectAllWorkspaces && !inspectSessionId) {
    failArgs("--all-workspaces requires a sessionId");
  }
  return {
    kind: "inspect",
    ...(inspectSessionId ? { inspectSessionId } : {}),
    inspectJson: Boolean(options.json),
    inspectAllWorkspaces,
    ...(inspectTurnId ? { inspectTurnId } : {}),
  };
}
