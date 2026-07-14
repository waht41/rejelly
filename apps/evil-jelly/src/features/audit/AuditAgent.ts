/**
 * Architecture-audit agent (INV-0008): a generic driver over deterministic seed *families*
 * (token-level clone duplication, function complexity, …). Each family owns its Phase-1 detector,
 * Phase-2 evaluator and ledger identity; this driver applies the shared machinery uniformly:
 *
 *   Phase 1  deterministic fan-out  — family.collect() produces seeds + identities (zero LLM)
 *   Phase 2  agentic per-seed loop  — family evaluator judges each new/changed seed (bounded budget)
 *   Phase 3  deterministic fan-in   — aggregate verdicts across families → ranked report, persist
 *
 * Read-only and one-shot: it produces refactor *proposals*; executing them is left to UnifiedAgent.
 * Exposed only as the `evil audit` subcommand; deliberately NOT wired into UnifiedAgent
 * (DR-0005 narrow workflow).
 */

import { createAgent } from "@rejelly/core";
import { getBinding } from "../../services/binding/hostBindings";
import { getWorkspaceFsPolicy } from "../../shared/fs-policy/workspace-fs-policy";
import { mapWithConcurrency } from "../../shared/lib/mapWithConcurrency";
import { getSettings } from "../../shared/settings";
import { cloneFamily } from "./families/clone";
import { complexityFamily } from "./families/complexity";
import { docDriftFamily } from "./families/docDrift";
import { docSyncFamily } from "./families/docSync";
import { fragmentationFamily } from "./families/fragmentation";
import {
  type AuditLedgerStats,
  decideLedgerReuse,
  loadAuditLedger,
  markResolvedLedgerEntries,
  pruneStaleLedgerEntries,
  recordFindingInLedger,
  saveAuditLedger,
  touchCurrentIdentity,
} from "./runtime/ledger";
import { persistAuditReport, renderAuditReport, summarizeAuditReport } from "./runtime/report";
import type { AuditSeedFamily, PreparedSeed } from "./types";
import {
  AUDIT_DEFAULTS,
  type AuditAgentProps,
  type AuditCollectOptions,
  type AuditFamilyStats,
  type AuditFinding,
  type AuditLedgerFile,
  type AuditSeedIdentity,
} from "./types";

type PrintOut = ReturnType<typeof getBinding>["printOut"];

const ALL_FAMILY_IMPLS: AuditSeedFamily[] = [
  cloneFamily,
  complexityFamily,
  fragmentationFamily,
  docDriftFamily,
  docSyncFamily,
];

function selectFamilies(kind: AuditAgentProps["family"]): AuditSeedFamily[] {
  const family = ALL_FAMILY_IMPLS.find((f) => f.kind === kind);
  if (!family) {
    throw new Error(`Unknown audit family "${kind}"`);
  }
  return [family];
}

function findingFromLedger(
  prepared: PreparedSeed,
  reuse: ReturnType<typeof decideLedgerReuse>,
): AuditFinding | null {
  if (reuse.action === "skip" && reuse.entry?.lastVerdict) {
    return {
      seed: prepared.seed,
      identity: prepared.identity,
      verdict: reuse.entry.lastVerdict,
      ledger: { source: "skipped", status: reuse.entry.status, reason: reuse.reason },
    };
  }
  if (reuse.action === "reuse" && reuse.entry?.lastVerdict) {
    return {
      seed: prepared.seed,
      identity: prepared.identity,
      verdict: reuse.entry.lastVerdict,
      ledger: { source: "reused", status: reuse.entry.status },
    };
  }
  return null;
}

async function evaluatePreparedSeeds(
  seeds: PreparedSeed[],
  familyLabel: string,
  concurrency: number,
  printOut: PrintOut,
): Promise<AuditFinding[]> {
  if (seeds.length === 0) {
    return [];
  }
  // Unordered fan-out: seeds are independent and only aggregated at the end, so a slow seed must
  // not stall scheduling of the rest (head-of-line blocking). Results stay in seed order.
  return await mapWithConcurrency(
    seeds,
    concurrency,
    async (prepared: PreparedSeed): Promise<AuditFinding> => {
      try {
        const verdict = await prepared.evaluate();
        return {
          seed: prepared.seed,
          identity: prepared.identity,
          verdict,
          ledger: { source: "evaluated", status: "open" },
        };
      } catch (error) {
        return {
          seed: prepared.seed,
          identity: prepared.identity,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    (finding, _prepared, completed) => {
      const tag = finding.error
        ? "error"
        : finding.verdict?.isActionable
          ? `${finding.verdict.severity} ${finding.verdict.category}`
          : "not actionable";
      printOut(
        `[Audit]   (${completed}/${seeds.length}) ${familyLabel} ${finding.seed.id}: ${tag}\n`,
      );
    },
  );
}

// ---------------------------------------------------------------------------
// processFamily internal steps
// ---------------------------------------------------------------------------

interface SplitResult {
  cachedFindings: AuditFinding[];
  evaluationCandidates: PreparedSeed[];
}

/** Split prepared seeds into cached (reused/skipped) vs. needs-evaluation. */
function splitByLedger(
  prepared: PreparedSeed[],
  ledger: AuditLedgerFile,
  ledgerStats: AuditLedgerStats,
): SplitResult {
  const cachedFindings: AuditFinding[] = [];
  const evaluationCandidates: PreparedSeed[] = [];
  for (const seed of prepared) {
    const cached = findingFromLedger(seed, decideLedgerReuse(ledger, seed.identity));
    if (cached) {
      cachedFindings.push(cached);
      if (cached.ledger?.source === "reused") {
        ledgerStats.reused++;
      } else if (cached.ledger?.source === "skipped") {
        ledgerStats.skippedSuppressed++;
      }
    } else {
      evaluationCandidates.push(seed);
    }
  }
  return { cachedFindings, evaluationCandidates };
}

/** Build the one-line plan string for a family (printed before evaluating). */
function formatFamilyPlanLine(
  family: AuditSeedFamily,
  stats: AuditFamilyStats,
  cachedFindings: AuditFinding[],
  toEvaluate: PreparedSeed[],
  skipped: number,
  concurrency: number,
): string {
  const reused = cachedFindings.filter((f) => f.ledger?.source === "reused").length;
  const suppressed = cachedFindings.filter((f) => f.ledger?.source === "skipped").length;
  return (
    `[Audit] ${family.label}: ${stats.candidatesFound} candidate(s)` +
    `${stats.preFiltered > 0 ? `, ${stats.preFiltered} pre-filtered` : ""}; ` +
    `${stats.warnings && stats.warnings.length > 0 ? `${stats.warnings.length} warning(s); ` : ""}` +
    `${reused} reused, ${suppressed} suppressed by ledger; ` +
    `evaluating ${toEvaluate.length} new/changed` +
    `${skipped > 0 ? ` (${skipped} beyond --max-seeds skipped)` : ""}` +
    `${toEvaluate.length > 0 ? ` with concurrency ${concurrency}` : ""}.\n`
  );
}

/** Update ledger entries for one family's findings and mark resolved. */
function reconcileLedger(
  ledger: AuditLedgerFile,
  findings: AuditFinding[],
  prepared: PreparedSeed[],
  kind: AuditSeedIdentity["kind"],
  nowIso: string,
  ledgerStats: AuditLedgerStats,
  partialScan: boolean,
  ledgerGcDays: number | undefined,
): void {
  for (const finding of findings) {
    if (recordFindingInLedger(ledger, finding, nowIso)) {
      ledgerStats.updated++;
    }
  }
  const findingIds = new Set(
    findings.map((f) => f.identity?.id).filter((id): id is string => typeof id === "string"),
  );
  for (const seed of prepared) {
    if (!findingIds.has(seed.identity.id)) {
      touchCurrentIdentity(ledger, seed.identity, nowIso);
    }
  }
  // A narrowed scan (e.g. --doc) only proves what it saw; absent seeds are unknown, not resolved.
  if (!partialScan) {
    const currentIds = new Set(prepared.map((seed) => seed.identity.id));
    ledgerStats.resolved += markResolvedLedgerEntries(ledger, currentIds, kind, nowIso);
    if (ledgerGcDays !== undefined) {
      ledgerStats.pruned += pruneStaleLedgerEntries(ledger, kind, nowIso, ledgerGcDays);
    }
  }
}

/** Run one family end-to-end: collect → ledger reuse split → evaluate → record → resolve bookkeeping. */
async function processFamily(
  family: AuditSeedFamily,
  ledger: AuditLedgerFile,
  maxSeeds: number,
  concurrency: number,
  nowIso: string,
  printOut: PrintOut,
  ledgerStats: AuditLedgerStats,
  collectOptions: AuditCollectOptions,
  ledgerGcDays: number | undefined,
): Promise<{ findings: AuditFinding[]; stats: AuditFamilyStats }> {
  printOut(`\n[Audit] Phase 1 — ${family.label}: scanning…\n`);
  const { prepared, stats, partial } = await family.collect(collectOptions);

  // Step 1: split by ledger — separate cached (reused/skipped) from seeds needing evaluation.
  const { cachedFindings, evaluationCandidates } = splitByLedger(prepared, ledger, ledgerStats);

  // Step 2: cap at maxSeeds and log the family plan.
  const toEvaluate = evaluationCandidates.slice(0, maxSeeds);
  const skipped = evaluationCandidates.length - toEvaluate.length;
  printOut(formatFamilyPlanLine(family, stats, cachedFindings, toEvaluate, skipped, concurrency));
  for (const warning of stats.warnings ?? []) {
    printOut(`[Audit]   Warning: ${warning}\n`);
  }

  // Step 3: evaluate new/changed seeds (agentic per-seed loop).
  const evaluated = await evaluatePreparedSeeds(toEvaluate, family.label, concurrency, printOut);
  const findings = [...cachedFindings, ...evaluated];

  // Step 4: update ledger entries, mark resolved, tally stats.
  reconcileLedger(
    ledger,
    findings,
    prepared,
    family.kind,
    nowIso,
    ledgerStats,
    partial === true,
    ledgerGcDays,
  );

  return { findings, stats };
}

export const AuditAgent = createAgent<AuditAgentProps, string>({
  id: "audit_agent",
  handler: async (props) => {
    const { printOut } = getBinding();
    const settings = getSettings();
    const maxSeeds = props.maxSeeds ?? settings.audit.maxSeeds ?? AUDIT_DEFAULTS.maxSeeds;
    const concurrency =
      props.concurrency ?? settings.audit.concurrency ?? AUDIT_DEFAULTS.concurrency;
    const ledgerGcDays =
      props.disableLedgerGc || settings.audit.disableLedgerGc
        ? undefined
        : (props.ledgerGcDays ?? settings.audit.ledgerGcDays ?? AUDIT_DEFAULTS.ledgerGcDays);
    const families = selectFamilies(props.family);
    const generatedAt = new Date().toISOString();

    const ledger = await loadAuditLedger(generatedAt);
    const ledgerStats: AuditLedgerStats = {
      loaded: Object.keys(ledger.entries).length,
      reused: 0,
      skippedSuppressed: 0,
      updated: 0,
      resolved: 0,
      pruned: 0,
    };

    const allFindings: AuditFinding[] = [];
    const detectors: AuditFamilyStats[] = [];
    if (props.family) {
      printOut(`[Audit] Family filter: ${props.family}\n`);
    }
    if (props.onlyActionable) {
      printOut("[Audit] Report filter: only actionable findings.\n");
    }
    const collectOptions: AuditCollectOptions = {
      ...(props.docFilter !== undefined ? { docFilter: props.docFilter } : {}),
      ...(props.docCodePaths !== undefined ? { docCodePaths: props.docCodePaths } : {}),
    };
    for (const family of families) {
      const { findings, stats } = await processFamily(
        family,
        ledger,
        maxSeeds,
        concurrency,
        generatedAt,
        printOut,
        ledgerStats,
        collectOptions,
        ledgerGcDays,
      );
      allFindings.push(...findings);
      detectors.push(stats);
    }

    await saveAuditLedger(ledger, generatedAt);

    const evaluatedCount = allFindings.filter(
      (f) => f.ledger?.source !== "reused" && f.ledger?.source !== "skipped",
    ).length;
    const data = {
      generatedAt,
      workspaceRoot: getWorkspaceFsPolicy().getRoot(),
      detectors,
      ledger: ledgerStats,
      evaluatedCount,
      findings: allFindings,
    };
    const markdown = renderAuditReport(data, { onlyActionable: props.onlyActionable });

    printOut("\n[Audit] Phase 3 — aggregating report…\n");
    const savedPath = await persistAuditReport(markdown, generatedAt);
    printOut(`\n${summarizeAuditReport(data, { onlyActionable: props.onlyActionable })}\n`);
    if (savedPath) {
      printOut(`[Audit] Report written to ${savedPath}\n`);
    }

    return markdown;
  },
});
