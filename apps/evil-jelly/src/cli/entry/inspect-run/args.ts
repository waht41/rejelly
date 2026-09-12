import type { CAC } from "cac";

export interface InspectCommandArgs {
  readonly kind: "inspect";
  readonly inspectSessionId?: string;
  readonly inspectJson: boolean;
  readonly inspectAllWorkspaces: boolean;
  readonly inspectTurnId?: string;
  readonly inspectSegment?: string;
  readonly inspectTools?: string;
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
    .option("--tools [selector]", "Inspect Tool calls (all, Tool name, or ToolCall ID)")
    .option("--models [selector]", "Inspect Model calls; selector may be an address or range")
    .option("--tokens", "Use the Model Call token profile")
    .option("--latency", "Use the Model Call latency profile")
    .option("--transport", "Use the Model Call transport profile")
    .option("--input", "Include persisted input composition for one --models address")
    .option("--attempts", "Include retry/attempt diagnostics for one --models address")
    .option("--payload", "Print only the complete persisted payload")
    .option("--full", "Show the complete payload in the human-readable inspection report")
    .option("--output <path>", "Write output directly to a UTF-8 file instead of stdout")
    .option("--top <number>", "Limit largest segments or Tool calls in the selected scope")
    .option("--all-workspaces", "Find the Session id across all Evil Jelly workspaces")
    .usage(
      "inspect [sessionId] [--turn <number-or-id>] [--tools [selector] | --models [selector] | --segment <address>] [--tokens | --latency | --transport] [--input | --attempts] [--full | --json | --payload] [--output <path>] [--top <number>] [--all-workspaces]",
    );
}

export function parseInspectArgs(
  args: readonly string[],
  options: Record<string, unknown>,
): InspectCommandArgs {
  const [rawSessionId, ...rest] = args;
  if (rest.length > 0) failArgs(`Unknown inspect argument: ${rest[0]}`);
  for (const removedOption of ["tool", "model", "call", "toolCall"] as const) {
    if (options[removedOption] !== undefined)
      failArgs(
        `Unknown inspect option: --${removedOption === "toolCall" ? "tool-call" : removedOption}`,
      );
  }
  const inspectSessionId = resolveOptionalString(rawSessionId);
  const inspectAllWorkspaces = Boolean(options.allWorkspaces);
  const inspectTurnId = resolveOptionalString(options.turn);
  const inspectSegment = resolveOptionalString(options.segment);
  const inspectTools = options.tools === true ? "" : resolveOptionalString(options.tools);
  const modelSelector = options.models === true ? "" : resolveOptionalString(options.models);
  const inspectModelId =
    modelSelector && /^M?[1-9]\d*$/i.test(modelSelector) ? modelSelector : undefined;
  const inspectModels = inspectModelId ? undefined : modelSelector;
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
  const toolsSelected = inspectTools !== undefined;
  const modelsSelected = modelSelector !== undefined;
  const drilldowns = [Boolean(inspectSegment), toolsSelected, modelsSelected];
  if (drilldowns.filter(Boolean).length > 1) {
    failArgs("--segment, --tools, and --models are mutually exclusive");
  }
  if (inspectModelId && inspectTurnId)
    failArgs("An exact --models address cannot be combined with --turn");
  if (inspectModels && inspectTurnId)
    failArgs("An explicit --models range cannot be combined with --turn");
  if (inspectModelView !== "balanced" && !modelsSelected) {
    failArgs("--tokens, --latency, and --transport require --models");
  }
  if (inspectModelView !== "balanced" && inspectModelId) {
    failArgs(
      "--tokens, --latency, and --transport cannot be combined with an exact --models address",
    );
  }
  if ((inspectInput || inspectAttempts) && !inspectModelId) {
    failArgs("--input and --attempts require an exact --models address");
  }
  if ([inspectFull, inspectJson, inspectPayload].filter(Boolean).length > 1) {
    failArgs("--full, --json, and --payload cannot be combined");
  }
  if ((inspectPayload || inspectFull) && !inspectSegment && !inspectTools) {
    failArgs("--payload and --full require --segment or a --tools selector");
  }
  if (inspectTop !== undefined && (inspectSegment || modelsSelected)) {
    failArgs("--top cannot be combined with --segment or --models");
  }
  return {
    kind: "inspect",
    ...(inspectSessionId ? { inspectSessionId } : {}),
    inspectJson,
    inspectAllWorkspaces,
    ...(inspectTurnId ? { inspectTurnId } : {}),
    ...(inspectSegment ? { inspectSegment } : {}),
    ...(inspectTools !== undefined ? { inspectTools } : {}),
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
