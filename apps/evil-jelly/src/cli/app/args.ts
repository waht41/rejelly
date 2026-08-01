/** CLI commands for the evil binary (cac). */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cac from "cac";
import {
  SELECTABLE_AUDIT_FAMILIES,
  type SelectableAuditFamilyKind,
} from "../../shared/contracts/audit";
import type { SettingsCliOverrides } from "../../shared/settings";

type CommonParsedArgs = {
  /** OPENAI_API_KEY override from CLI; highest priority. */
  cliApiKey: string | undefined;
  /** `--env` profile name or path: one file per endpoint identity, outranking the shell. */
  envFile: string | undefined;
  review: boolean;
  /** Resolved absolute path when --workspace is set (agent workspace fs policy root). */
  workspace: string | undefined;
  /** Per-invocation settings overrides (seeded into initSettings at the composition root). */
  settings: SettingsCliOverrides;
};

type ParseCtx = {
  args: ReadonlyArray<string>;
  options: Record<string, unknown>;
  common: CommonParsedArgs;
};

export type ParsedInitArgs = CommonParsedArgs & {
  kind: "init";
  /** OPENAI_BASE_URL to persist alongside the key when --base-url is set. */
  initBaseUrl: string | undefined;
  /** OPENAI_MODEL_ID to persist when --model is set. */
  initModelId: string | undefined;
};

export type ParsedAuditArgs = CommonParsedArgs & {
  kind: "audit";
  /** Options passed to AuditAgent. Every audit run names exactly one family. */
  auditOptions: {
    family: SelectableAuditFamilyKind;
    onlyActionable?: boolean;
    docFilter?: string;
    docCodePaths?: string[];
    maxSeeds?: number;
    ledgerGcDays?: number;
    disableLedgerGc?: boolean;
  };
};

export type RunStartupArgs =
  | {
      kind: "fresh";
      /** First user line when --input is set. */
      seedInput: string | undefined;
    }
  | {
      kind: "resume";
      /** Explicit sessionId when --resume <id> was passed; undefined means "pick interactively". */
      sessionId: string | undefined;
      /** First user line when --input is set. */
      seedInput: string | undefined;
    }
  | {
      kind: "snapshot";
      /** Review trace id to restore before starting the run. */
      traceId: string;
      /** First user line when --input is set. */
      seedInput: string | undefined;
    }
  | {
      kind: "mock";
      /** Review trace id to replay with a mock model. */
      traceId: string;
      /** Enqueue user inputs recovered from the trace. */
      enqueueTraceInputs: boolean;
      /** Mock input is recovered from the trace or entered manually. */
      seedInput?: undefined;
    };

export type ParsedRunArgs = CommonParsedArgs & {
  kind: "run";
  startup: RunStartupArgs;
  /** Run UnifiedAgent once without Ink. */
  headless: boolean;
  /** Explicitly accept confirmTool requests in headless mode (test/eval harness only). */
  autoAccept: boolean;
};

export type ParsedEvilJellyArgs = ParsedInitArgs | ParsedAuditArgs | ParsedRunArgs;

function resolveAuditFamily(raw: unknown): SelectableAuditFamilyKind {
  if (raw === undefined || raw === null || raw === false) {
    fail(`audit requires --family <name>. Allowed: ${SELECTABLE_AUDIT_FAMILIES.join(", ")}`);
  }
  const name = String(raw).trim();
  if (!name) {
    fail(`audit requires --family <name>. Allowed: ${SELECTABLE_AUDIT_FAMILIES.join(", ")}`);
  }
  if ((SELECTABLE_AUDIT_FAMILIES as readonly string[]).includes(name)) {
    return name as SelectableAuditFamilyKind;
  }
  console.error(
    `--family: unknown "${name}". Allowed: ${SELECTABLE_AUDIT_FAMILIES.join(", ")}. ` +
      `Use "evil audit --family doc-drift" for doc-drift.`,
  );
  process.exit(1);
}

export function getCliVersion(): string {
  // The source module lives at src/cli/app/args.ts, while tsup bundles it into dist/cli/index.js.
  // Try both layouts and verify the package name so a parent workspace package cannot win by
  // accident if the output structure changes.
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

function resolveOptionalPath(raw: unknown, baseDir = process.cwd()): string | undefined {
  if (raw === undefined || raw === null || String(raw).trim().length === 0) {
    return undefined;
  }
  return path.resolve(baseDir, String(raw).trim());
}

function resolveOptionalString(raw: unknown, trim = true): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const value = trim ? String(raw).trim() : String(raw);
  return value.length > 0 ? value : undefined;
}

function resolveOptionalStringArray(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === false) {
    return [];
  }
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map((value) => String(value).trim()).filter((value) => value.length > 0);
}

function resolvePositiveInteger(raw: unknown, flagName: string): number | undefined {
  if (raw === undefined || raw === null || raw === false) {
    return undefined;
  }
  const text = String(raw).trim();
  if (text.length === 0) {
    return undefined;
  }
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    fail(`${flagName} must be a positive integer; unbounded values are not supported.`);
  }
  return parsed;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
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
    fail(`${selected.join(", ")} are mutually exclusive run startup modes`);
  }
  if (mockInputs && mockTraceId === undefined) {
    fail("--mock-inputs requires --mock <traceId>");
  }
  if (mockInputs && seedInput !== undefined) {
    fail("--mock-inputs cannot be combined with --input; trace inputs provide the queue");
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
  .option("--review", "Enable review trace exporter")
  .option(
    "--devtool",
    "Connect the devtool MCP toolset (needs a running devtool server; usually with --review)",
  )
  .option(
    "--doc-map <path>",
    "Doc map path for doc-drift validation, workspace-relative (default: .evil-jelly/doc-map.jsonc)",
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

cli
  .command("init", "Setup global config file under ~/.evil-jelly/.env")
  .option(
    "--base-url <url>",
    "OPENAI_BASE_URL to save alongside the key (keeps key and endpoint in the same layer)",
  )
  .option("--model <id>", "OPENAI_MODEL_ID to save");

cli
  .command("audit", "Run the one-shot audit/report workflow")
  .usage("audit --family <name> [options]")
  .option(
    "--family <name>",
    "Required; one of clone, complexity, fragmentation, doc-drift, or doc-sync",
  )
  .option("--only-actionable", "Audit report: render only actionable findings")
  .option("--max-seeds <n>", "Positive limit on new or changed seeds to evaluate")
  .option("--ledger-gc-days <n>", "Positive stale-entry age in days for ledger pruning")
  .option("--no-ledger-gc", "Disable stale ledger pruning for this run")
  .option(
    "--doc <file>",
    "doc-drift only: validate one document by basename or workspace-relative path",
  )
  .option(
    "--code <path>",
    "doc-drift only: requires --doc; add a temporary workspace-relative code path (repeatable; bypasses doc-map)",
  );

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

function parseAuditCommand({ args, options, common }: ParseCtx): ParsedAuditArgs {
  if (args.length > 0) {
    fail(`Unknown audit argument: ${String(args[0])}`);
  }
  const auditFamily = resolveAuditFamily(options.family);
  const auditDocFilter = resolveOptionalString(options.doc);
  const auditDocCodePaths = resolveOptionalStringArray(options.code);
  const maxSeeds = resolvePositiveInteger(options.maxSeeds, "--max-seeds");
  const ledgerGcDays = resolvePositiveInteger(options.ledgerGcDays, "--ledger-gc-days");
  if (auditDocCodePaths.length > 0 && auditDocFilter === undefined) {
    fail("--code requires --doc <file>");
  }
  if (
    (auditDocFilter !== undefined || auditDocCodePaths.length > 0) &&
    auditFamily !== "doc-drift"
  ) {
    fail("--doc/--code require --family doc-drift");
  }
  return {
    ...common,
    kind: "audit",
    auditOptions: {
      family: auditFamily,
      ...(options.onlyActionable ? { onlyActionable: true } : {}),
      ...(auditDocFilter !== undefined ? { docFilter: auditDocFilter } : {}),
      ...(auditDocCodePaths.length > 0 ? { docCodePaths: auditDocCodePaths } : {}),
      ...(maxSeeds !== undefined ? { maxSeeds } : {}),
      ...(ledgerGcDays !== undefined ? { ledgerGcDays } : {}),
      ...(options.ledgerGc === false ? { disableLedgerGc: true } : {}),
    },
  };
}

function parseRunCommand({ args, options, common }: ParseCtx): ParsedRunArgs {
  if (args.length > 0) {
    fail(`Unknown command or argument: ${String(args[0])}`);
  }
  const startup = resolveRunStartup(options);
  const headless = Boolean(options.headless);
  const autoAccept = Boolean(options.autoAccept);
  if (headless && startup.kind !== "fresh") {
    fail("--headless cannot be combined with --resume, --snapshot, or --mock");
  }
  if (autoAccept && !headless) {
    fail("--auto-accept requires --headless");
  }
  if (
    options.family !== undefined ||
    options.onlyActionable !== undefined ||
    options.doc !== undefined ||
    options.code !== undefined ||
    options.maxSeeds !== undefined ||
    options.ledgerGcDays !== undefined ||
    options.ledgerGc === false
  ) {
    fail(
      "--family/--only-actionable/--max-seeds/--ledger-gc-days/--no-ledger-gc/--doc/--code require the audit subcommand",
    );
  }
  const headlessSeedInput = startup.kind === "fresh" ? startup.seedInput : undefined;
  if (headless && (headlessSeedInput === undefined || headlessSeedInput.trim().length === 0)) {
    fail("--headless requires --input <text>");
  }
  return {
    ...common,
    kind: "run",
    review: common.review || startup.kind === "snapshot",
    startup,
    headless,
    autoAccept,
  };
}

const commandParsers: Record<string, (ctx: ParseCtx) => ParsedEvilJellyArgs> = {
  init: ({ common, options }) => ({
    ...common,
    kind: "init",
    initBaseUrl: resolveOptionalString(options.baseUrl),
    initModelId: resolveOptionalString(options.model),
  }),
  audit: parseAuditCommand,
};

export function parseCliArgs(argv: string[] = process.argv): ParsedEvilJellyArgs {
  cli.unsetMatchedCommand();
  // `--` conventionally ends option parsing. If a package manager forwards it as the first
  // script argument, CAC intentionally ignores everything after it; without this guard an audit
  // invocation can therefore look like a bare command and accidentally launch interactive Ink.
  if (argv[2] === "--" && argv.length > 3) {
    fail(
      "Unexpected leading `--`: it stops Evil Jelly from parsing the following command. " +
        "When using pnpm, omit it (for example: `pnpm ... start --review audit ...`).",
    );
  }
  const { args, options } = cli.parse(argv, { run: false });
  if (options.cwd !== undefined) {
    throw new Error("Unknown option `--cwd`; use `--workspace <dir>` instead");
  }
  const workspace = resolveOptionalPath(options.workspace);
  const auditMaxSeeds = resolvePositiveInteger(options.maxSeeds, "--max-seeds");
  const auditLedgerGcDays = resolvePositiveInteger(options.ledgerGcDays, "--ledger-gc-days");
  const common: CommonParsedArgs = {
    cliApiKey: resolveOptionalString(options.apiKey),
    envFile: resolveOptionalString(options.env),
    review: Boolean(options.review),
    workspace,
    settings: {
      docMap: resolveOptionalString(options.docMap),
      devtoolMcp: options.devtool ? true : undefined,
      auditMaxSeeds,
      auditLedgerGcDays,
      auditDisableLedgerGc: options.ledgerGc === false ? true : undefined,
    },
  };

  if (options.help || options.version) {
    process.exit(0);
  }

  const commandName = cli.matchedCommandName ?? cli.matchedCommand?.name ?? "";
  const ctx: ParseCtx = { args, options, common };
  const parser = commandParsers[commandName];
  return parser ? parser(ctx) : parseRunCommand(ctx);
}
