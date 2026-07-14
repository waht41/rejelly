/**
 * Shared audit ledger repository and lifecycle helpers.
 *
 * The ledger is detector-agnostic: each detector supplies an AuditSeedIdentity, while this module
 * owns persistence, verdict reuse, suppression and resolved-state bookkeeping.
 */

import { createHash } from "node:crypto";
import { getWorkspaceFsPolicy } from "../../../shared/fs-policy/workspace-fs-policy";
import type {
  AuditFinding,
  AuditLedgerEntry,
  AuditLedgerFile,
  AuditLedgerStatus,
  AuditSeedIdentity,
  SeedVerdict,
} from "../types";

/** SHA-256 hex digest — used by the ledger and seed-family identity resolvers. */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export const AUDIT_LEDGER_PATH = ".evil-jelly/audit/ledger.json";

export interface LedgerReuseDecision {
  action: "evaluate" | "reuse" | "skip";
  entry?: AuditLedgerEntry;
  status?: AuditLedgerStatus;
  reason?: string;
}

export interface AuditLedgerStats {
  loaded: number;
  reused: number;
  skippedSuppressed: number;
  updated: number;
  resolved: number;
  pruned: number;
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

function hashVerdict(verdict: SeedVerdict): string {
  return sha256(stableJsonStringify(verdict));
}

function emptyLedger(updatedAt: string): AuditLedgerFile {
  return { version: 1, updatedAt, entries: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSeedVerdict(value: unknown): value is SeedVerdict {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.isActionable === "boolean" &&
    (value.severity === "high" || value.severity === "medium" || value.severity === "low") &&
    typeof value.category === "string" &&
    typeof value.summary === "string" &&
    typeof value.rationale === "string" &&
    typeof value.proposal === "string"
  );
}

function sanitizeLedgerEntries(
  entries: Record<string, AuditLedgerEntry>,
): Record<string, AuditLedgerEntry> {
  const sanitized: Record<string, AuditLedgerEntry> = {};
  for (const [id, entry] of Object.entries(entries)) {
    if (entry.lastVerdict && !isSeedVerdict(entry.lastVerdict)) {
      continue;
    }
    sanitized[id] = entry;
  }
  return sanitized;
}

export async function loadAuditLedger(nowIso: string): Promise<AuditLedgerFile> {
  const policy = getWorkspaceFsPolicy();
  try {
    const raw = await policy.readFile(AUDIT_LEDGER_PATH);
    const parsed = JSON.parse(raw) as Partial<AuditLedgerFile>;
    if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
      return emptyLedger(nowIso);
    }
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : nowIso,
      entries: sanitizeLedgerEntries(parsed.entries as Record<string, AuditLedgerEntry>),
    };
  } catch {
    return emptyLedger(nowIso);
  }
}

export async function saveAuditLedger(ledger: AuditLedgerFile, nowIso: string): Promise<void> {
  const policy = getWorkspaceFsPolicy();
  ledger.updatedAt = nowIso;
  await policy.mkdir(".evil-jelly/audit", { recursive: true });
  await policy.writeFile(AUDIT_LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`);
}

/**
 * Decide whether an unchanged seed needs an LLM call. Suppressed unchanged findings are skipped
 * entirely; other unchanged findings reuse their cached verdict in the active report.
 */
export function decideLedgerReuse(
  ledger: AuditLedgerFile,
  identity: AuditSeedIdentity,
): LedgerReuseDecision {
  const entry = ledger.entries[identity.id];
  if (
    !entry ||
    entry.contentHash !== identity.contentHash ||
    !entry.lastVerdict ||
    !isSeedVerdict(entry.lastVerdict)
  ) {
    return { action: "evaluate", entry };
  }
  if (entry.status === "suppressed") {
    return {
      action: "skip",
      entry,
      status: entry.status,
      reason: entry.suppressionReason ?? "suppressed in audit ledger",
    };
  }
  return { action: "reuse", entry, status: entry.status };
}

function statusForVerdict(
  existing: AuditLedgerEntry | undefined,
  verdict: SeedVerdict,
): AuditLedgerStatus {
  if (!verdict.isActionable) {
    return "suppressed";
  }
  if (existing?.status === "accepted") {
    return "accepted";
  }
  return "open";
}

/** Upsert one evaluated/reused finding into the ledger. Errors intentionally do not overwrite verdicts. */
export function recordFindingInLedger(
  ledger: AuditLedgerFile,
  finding: AuditFinding,
  nowIso: string,
): boolean {
  const { identity, verdict } = finding;
  if (!identity || !verdict) {
    return false;
  }

  const existing = ledger.entries[identity.id];
  const reused = finding.ledger?.source !== "evaluated";
  const status = reused
    ? (existing?.status ?? statusForVerdict(existing, verdict))
    : statusForVerdict(existing, verdict);
  const suppressionReason =
    status === "suppressed" ? (existing?.suppressionReason ?? verdict.rationale) : undefined;

  ledger.entries[identity.id] = {
    ...identity,
    status,
    firstSeen: existing?.firstSeen ?? nowIso,
    lastSeen: nowIso,
    lastEvaluatedAt: reused ? existing?.lastEvaluatedAt : nowIso,
    lastVerdict: verdict,
    lastVerdictHash: hashVerdict(verdict),
    suppressionReason,
  };
  return true;
}

/** Update lastSeen for current seeds that were not evaluated due maxSeeds or reused elsewhere. */
export function touchCurrentIdentity(
  ledger: AuditLedgerFile,
  identity: AuditSeedIdentity,
  nowIso: string,
): void {
  const existing = ledger.entries[identity.id];
  if (!existing) {
    return;
  }
  ledger.entries[identity.id] = {
    ...existing,
    ...identity,
    lastSeen: nowIso,
    resolvedAt: undefined,
    status: existing.status === "resolved" ? "open" : existing.status,
  };
}

/** Mark entries of the current kind that no longer appear in this run as resolved. */
export function markResolvedLedgerEntries(
  ledger: AuditLedgerFile,
  currentIds: Set<string>,
  kind: AuditSeedIdentity["kind"],
  nowIso: string,
): number {
  let resolved = 0;
  for (const entry of Object.values(ledger.entries)) {
    if (entry.kind !== kind || currentIds.has(entry.id) || entry.status === "resolved") {
      continue;
    }
    ledger.entries[entry.id] = {
      ...entry,
      status: "resolved",
      resolvedAt: nowIso,
    };
    resolved++;
  }
  return resolved;
}

export function pruneStaleLedgerEntries(
  ledger: AuditLedgerFile,
  kind: AuditSeedIdentity["kind"],
  nowIso: string,
  olderThanDays: number,
): number {
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs) || !Number.isInteger(olderThanDays) || olderThanDays <= 0) {
    return 0;
  }
  const cutoffMs = nowMs - olderThanDays * 24 * 60 * 60 * 1000;
  let pruned = 0;
  for (const [id, entry] of Object.entries(ledger.entries)) {
    if (entry.kind !== kind || entry.status === "accepted") {
      continue;
    }
    const lastSeenMs = Date.parse(entry.lastSeen);
    if (!Number.isFinite(lastSeenMs) || lastSeenMs >= cutoffMs) {
      continue;
    }
    delete ledger.entries[id];
    pruned++;
  }
  return pruned;
}
