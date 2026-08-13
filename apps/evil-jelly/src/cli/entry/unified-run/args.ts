import type { CAC } from "cac";
import type { SettingsCliOverrides } from "../../../shared/configuration/settings";

export type RunStartupArgs =
  | { kind: "fresh"; seedInput: string | undefined }
  | { kind: "resume"; sessionId: string | undefined; seedInput: string | undefined }
  | { kind: "snapshot"; traceId: string; seedInput: string | undefined }
  | { kind: "mock"; traceId: string; enqueueTraceInputs: boolean; seedInput?: undefined };

export type UnifiedRunCommandArgs = {
  kind: "unified";
  startup: RunStartupArgs;
  /** Run UnifiedAgent once without Ink. */
  headless: boolean;
  /** Explicitly accept confirmTool requests in headless mode (test/eval harness only). */
  autoAccept: boolean;
};

function failArgs(message: string): never {
  console.error(message);
  process.exit(1);
}

function resolveOptionalString(raw: unknown, trim = true): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = trim ? String(raw).trim() : String(raw);
  return value.length > 0 ? value : undefined;
}

export function registerUnifiedRunArgs(cli: CAC): void {
  cli.option(
    "--devtool",
    "Connect the devtool MCP toolset (needs a running devtool server; usually with --review)",
  );
  cli
    .command("", "Start the interactive run loop")
    .option(
      "--snapshot <traceId>",
      "Restore a Review trace snapshot; mutually exclusive with --mock, --resume, and --headless",
    )
    .option(
      "--mock <traceId>",
      "Replay a Review trace with a mock model; mutually exclusive with --snapshot, --resume, and --headless",
    )
    .option(
      "--mock-inputs",
      "Enqueue user inputs recovered from the --mock trace; requires --mock and cannot be combined with --input",
    )
    .option(
      "--headless",
      "Run UnifiedAgent once without Ink; requires --input and cannot use --resume, --snapshot, or --mock",
    )
    .option(
      "--auto-accept",
      "Accept tool confirmations; requires --headless (test/eval harness only)",
    )
    .option(
      "--resume [sessionId]",
      "Resume a saved session by id, or omit the id to pick one; cannot use --snapshot, --mock, or --headless",
    )
    .option("--input <text>", "First user line without prompting; required by --headless");
}

export function unifiedSettingsOverrides(options: Record<string, unknown>): SettingsCliOverrides {
  return { devtoolMcp: options.devtool ? true : undefined };
}

function resolveRunStartup(options: Record<string, unknown>): RunStartupArgs {
  const snapshotTraceId = resolveOptionalString(options.snapshot);
  const mockTraceId = resolveOptionalString(options.mock);
  const mockInputs = Boolean(options.mockInputs);
  const seedInput = resolveOptionalString(options.input, false);
  const resumeRaw = options.resume;
  const resume = resumeRaw !== undefined && resumeRaw !== false;
  const resumeSessionId =
    typeof resumeRaw === "string" && resumeRaw.trim().length > 0 ? resumeRaw.trim() : undefined;
  const selected = [
    snapshotTraceId !== undefined ? "--snapshot" : undefined,
    mockTraceId !== undefined ? "--mock" : undefined,
    resume ? "--resume" : undefined,
  ].filter((value): value is string => value !== undefined);

  if (selected.length > 1) {
    failArgs(`${selected.join(", ")} are mutually exclusive run startup modes`);
  }
  if (mockInputs && mockTraceId === undefined) {
    failArgs("--mock-inputs requires --mock <traceId>");
  }
  if (mockInputs && seedInput !== undefined) {
    failArgs("--mock-inputs cannot be combined with --input; trace inputs provide the queue");
  }
  if (mockTraceId !== undefined) {
    return { kind: "mock", traceId: mockTraceId, enqueueTraceInputs: mockInputs };
  }
  if (snapshotTraceId !== undefined) {
    return { kind: "snapshot", traceId: snapshotTraceId, seedInput };
  }
  if (resume) {
    return { kind: "resume", sessionId: resumeSessionId, seedInput };
  }
  return { kind: "fresh", seedInput };
}

export function parseUnifiedRunArgs(
  args: ReadonlyArray<string>,
  options: Record<string, unknown>,
): UnifiedRunCommandArgs {
  if (args.length > 0) {
    failArgs(`Unknown command or argument: ${String(args[0])}`);
  }
  const startup = resolveRunStartup(options);
  const headless = Boolean(options.headless);
  const autoAccept = Boolean(options.autoAccept);
  if (headless && startup.kind !== "fresh") {
    failArgs("--headless cannot be combined with --resume, --snapshot, or --mock");
  }
  if (autoAccept && !headless) {
    failArgs("--auto-accept requires --headless");
  }
  const headlessSeedInput = startup.kind === "fresh" ? startup.seedInput : undefined;
  if (headless && (headlessSeedInput === undefined || headlessSeedInput.trim().length === 0)) {
    failArgs("--headless requires --input <text>");
  }
  return {
    kind: "unified",
    startup,
    headless,
    autoAccept,
  };
}
