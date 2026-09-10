import type { CAC } from "cac";

export interface InspectCommandArgs {
  readonly kind: "inspect";
  readonly inspectSessionId?: string;
  readonly inspectJson: boolean;
  readonly inspectAllWorkspaces: boolean;
  readonly inspectTurnId?: string;
  readonly inspectSegment?: string;
  readonly inspectCallId?: string;
  readonly inspectModels?: string;
  readonly inspectModelId?: string;
  readonly inspectModelView: "balanced" | "tokens" | "latency" | "transport";
  readonly inspectInput: boolean;
  readonly inspectAttempts: boolean;
  readonly inspectPayload: boolean;
  readonly inspectFull: boolean;
  readonly inspectOutput?: string;
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
    .option(
      "--models [range]",
      "Inspect Model Calls (Session summary, Turn list, or explicit M80..M100 range)",
    )
    .option(
      "--model <address>",
      "Inspect one Model Call by Session-global address (for example M85)",
    )
    .option("--tokens", "Use the Model Call token profile")
    .option("--latency", "Use the Model Call latency profile")
    .option("--transport", "Use the Model Call transport profile")
    .option("--input", "Include persisted input composition for --model")
    .option("--attempts", "Include retry/attempt diagnostics for --model")
    .option("--payload", "Print only the complete persisted payload")
    .option("--full", "Show the complete payload in the human-readable inspection report")
    .option("--output <path>", "Write output directly to a UTF-8 file instead of stdout")
    .option(
      "--top <number>",
      "Append the largest token-contributing segments across the selected scope",
    )
    .option("--all-workspaces", "Find the Session id across all Evil Jelly workspaces")
    .usage(
      "inspect [sessionId] [--turn <number-or-id>] [--models [range] | --model <M#> | --segment <address> | --call <id>] [--tokens | --latency | --transport] [--input | --attempts] [--full | --json | --payload] [--output <path>] [--top <number>] [--all-workspaces]",
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
  const inspectModels = options.models === true ? "" : resolveOptionalString(options.models);
  const inspectModelId = resolveOptionalString(options.model);
  const modelViews = [
    ["tokens", Boolean(options.tokens)],
    ["latency", Boolean(options.latency)],
    ["transport", Boolean(options.transport)],
  ] as const;
  const selectedModelViews = modelViews.filter(([, selected]) => selected);
  if (selectedModelViews.length > 1)
    failArgs("--tokens, --latency, and --transport cannot be combined");
  const inspectModelView: InspectCommandArgs["inspectModelView"] =
    selectedModelViews.length === 0 ? "balanced" : selectedModelViews[0][0];
  const inspectInput = Boolean(options.input);
  const inspectAttempts = Boolean(options.attempts);
  const inspectPayload = Boolean(options.payload);
  const inspectFull = Boolean(options.full);
  const inspectJson = Boolean(options.json);
  const inspectOutput = resolveOptionalString(options.output);
  const inspectTop = resolvePositiveInteger(options.top, "--top");
  if (inspectAllWorkspaces && !inspectSessionId) {
    failArgs("--all-workspaces requires a sessionId");
  }
  if (inspectSegment && !inspectTurnId) failArgs("--segment requires --turn");
  const modelListSelected = inspectModels !== undefined;
  const drilldowns = [
    Boolean(inspectSegment),
    Boolean(inspectCallId),
    modelListSelected,
    Boolean(inspectModelId),
  ];
  if (drilldowns.filter(Boolean).length > 1) {
    failArgs("--segment, --call, --models, and --model are mutually exclusive");
  }
  if (inspectCallId && inspectTurnId) failArgs("--call cannot be combined with --turn");
  if (inspectModelId && inspectTurnId) failArgs("--model cannot be combined with --turn");
  if (inspectModels && inspectTurnId)
    failArgs("An explicit --models range cannot be combined with --turn");
  if (inspectModelView !== "balanced" && !modelListSelected) {
    failArgs("--tokens, --latency, and --transport require --models");
  }
  if ((inspectInput || inspectAttempts) && !inspectModelId) {
    failArgs("--input and --attempts require --model");
  }
  if ([inspectFull, inspectJson, inspectPayload].filter(Boolean).length > 1) {
    failArgs("--full, --json, and --payload cannot be combined");
  }
  if ((inspectPayload || inspectFull) && !inspectSegment && !inspectCallId) {
    failArgs("--payload and --full require --segment or --call");
  }
  if (
    inspectTop !== undefined &&
    (inspectSegment || inspectCallId || modelListSelected || inspectModelId)
  ) {
    failArgs("--top cannot be combined with --segment, --call, --models, or --model");
  }
  return {
    kind: "inspect",
    ...(inspectSessionId ? { inspectSessionId } : {}),
    inspectJson,
    inspectAllWorkspaces,
    ...(inspectTurnId ? { inspectTurnId } : {}),
    ...(inspectSegment ? { inspectSegment } : {}),
    ...(inspectCallId ? { inspectCallId } : {}),
    ...(inspectModels !== undefined ? { inspectModels } : {}),
    ...(inspectModelId ? { inspectModelId } : {}),
    inspectModelView,
    inspectInput,
    inspectAttempts,
    inspectPayload,
    inspectFull,
    ...(inspectOutput ? { inspectOutput } : {}),
    ...(inspectTop !== undefined ? { inspectTop } : {}),
  };
}
