import type { CAC } from "cac";
import {
  SELECTABLE_AUDIT_FAMILIES,
  type SelectableAuditFamilyKind,
} from "../../../features/audit/contracts";
import type { SettingsCliOverrides } from "../../../shared/configuration/settings";
export type AuditCommandArgs = {
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

function failArgs(message: string): never {
  console.error(message);
  process.exit(1);
}

function resolveOptionalString(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim();
  return value.length > 0 ? value : undefined;
}

function resolveOptionalStringArray(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === false) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map((value) => String(value).trim()).filter(Boolean);
}

function resolvePositiveInteger(raw: unknown, flagName: string): number | undefined {
  if (raw === undefined || raw === null || raw === false) return undefined;
  const text = String(raw).trim();
  if (!text) return undefined;
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    failArgs(`${flagName} must be a positive integer; unbounded values are not supported.`);
  }
  return parsed;
}

function resolveAuditFamily(raw: unknown): SelectableAuditFamilyKind {
  if (raw === undefined || raw === null || raw === false) {
    failArgs(`audit requires --family <name>. Allowed: ${SELECTABLE_AUDIT_FAMILIES.join(", ")}`);
  }
  const name = String(raw).trim();
  if (!name) {
    failArgs(`audit requires --family <name>. Allowed: ${SELECTABLE_AUDIT_FAMILIES.join(", ")}`);
  }
  if ((SELECTABLE_AUDIT_FAMILIES as readonly string[]).includes(name)) {
    return name as SelectableAuditFamilyKind;
  }
  failArgs(
    `--family: unknown "${name}". Allowed: ${SELECTABLE_AUDIT_FAMILIES.join(", ")}. ` +
      `Use "evil audit --family doc-drift" for doc-drift.`,
  );
}

export function registerAuditArgs(cli: CAC): void {
  cli.option(
    "--doc-map <path>",
    "Doc map path for doc-drift validation, workspace-relative (default: .evil-jelly/doc-map.jsonc)",
  );
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
}

export function auditSettingsOverrides(options: Record<string, unknown>): SettingsCliOverrides {
  return {
    docMap: resolveOptionalString(options.docMap),
    auditMaxSeeds: resolvePositiveInteger(options.maxSeeds, "--max-seeds"),
    auditLedgerGcDays: resolvePositiveInteger(options.ledgerGcDays, "--ledger-gc-days"),
    auditDisableLedgerGc: options.ledgerGc === false ? true : undefined,
  };
}

export function hasAuditOnlyArgs(options: Record<string, unknown>): boolean {
  return (
    options.family !== undefined ||
    options.onlyActionable !== undefined ||
    options.doc !== undefined ||
    options.code !== undefined ||
    options.maxSeeds !== undefined ||
    options.ledgerGcDays !== undefined ||
    options.ledgerGc === false
  );
}

export function parseAuditArgs(
  args: ReadonlyArray<string>,
  options: Record<string, unknown>,
): AuditCommandArgs {
  if (args.length > 0) {
    failArgs(`Unknown audit argument: ${String(args[0])}`);
  }
  const auditFamily = resolveAuditFamily(options.family);
  const auditDocFilter = resolveOptionalString(options.doc);
  const auditDocCodePaths = resolveOptionalStringArray(options.code);
  const maxSeeds = resolvePositiveInteger(options.maxSeeds, "--max-seeds");
  const ledgerGcDays = resolvePositiveInteger(options.ledgerGcDays, "--ledger-gc-days");
  if (auditDocCodePaths.length > 0 && auditDocFilter === undefined) {
    failArgs("--code requires --doc <file>");
  }
  if (
    (auditDocFilter !== undefined || auditDocCodePaths.length > 0) &&
    auditFamily !== "doc-drift"
  ) {
    failArgs("--doc/--code require --family doc-drift");
  }
  return {
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
