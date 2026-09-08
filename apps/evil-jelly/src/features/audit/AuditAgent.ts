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

import { createAgent, expectResource } from "@rejelly/core";
import {
  MCP_AUDIT_PROVENANCE_RESOURCE_KEY,
  type McpAuditProvenanceCollector,
} from "../../domains/mcp/gateway/auditDispatch";
import { getSettings } from "../../shared/configuration/settings";
import { getWorkspaceRoot } from "../../shared/fs-policy/workspace-context";
import { getBinding } from "../../shared/host/context";
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
import { mapWithConcurrency } from "./runtime/mapWithConcurrency";
import { persistAuditReport, renderAuditReport, summarizeAuditReport } from "./runtime/report";
import type { AuditSeedFamily, PreparedSeed } from "./types";
import {
  AUDIT_DEFAULTS,
  type AuditAgentProps,
  type AuditCollectOptions,
  type AuditFamilyStats,
  type AuditFinding,
  type AuditLedgerFile,
  type AuditReportData,
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
  onFindingSettled: (finding: AuditFinding) => Promise<void>,
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
      let finding: AuditFinding;
      try {
        const verdict = await prepared.evaluate();
        finding = {
          seed: prepared.seed,
          identity: prepared.identity,
          verdict,
          ledger: { source: "evaluated", status: "open" },
        };
      } catch (error) {
        finding = {
          seed: prepared.seed,
          identity: prepared.identity,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      // Persist this result before counting it as settled. A later evaluator may hang or the user
      // may interrupt the run; completed work must already be present in the ledger and live report.
      await onFindingSettled(finding);
      return finding;
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

/** Record findings as they settle; errors intentionally leave any prior verdict untouched. */
function recordFindings(
  ledger: AuditLedgerFile,
  findings: AuditFinding[],
  nowIso: string,
  ledgerStats: AuditLedgerStats,
): void {
  for (const finding of findings) {
    if (recordFindingInLedger(ledger, finding, nowIso)) {
      ledgerStats.updated++;
    }
  }
}

/** Finalize identity bookkeeping only after the complete family scan has settled. */
function finalizeLedgerFamily(
  ledger: AuditLedgerFile,
  findings: AuditFinding[],
  prepared: PreparedSeed[],
  kind: AuditSeedIdentity["kind"],
  nowIso: string,
  ledgerStats: AuditLedgerStats,
  partialScan: boolean,
  ledgerGcDays: number | undefined,
): void {
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

interface AuditProgressSnapshot {
  findings: AuditFinding[];
  stats: AuditFamilyStats;
  settled: number;
  total: number;
  complete: boolean;
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
  persistProgress: (snapshot: AuditProgressSnapshot) => Promise<void>,
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

  const settledFindings = [...cachedFindings];
  recordFindings(ledger, cachedFindings, nowIso, ledgerStats);
  await persistProgress({
    findings: [...settledFindings],
    stats,
    settled: 0,
    total: toEvaluate.length,
    complete: false,
  });

  // Step 3: evaluate and durably checkpoint each new/changed seed. The promise chain serializes
  // writes from concurrent workers, preventing stale report or ledger snapshots from winning races.
  let settled = 0;
  let checkpointChain = Promise.resolve();
  const checkpointFinding = (finding: AuditFinding): Promise<void> => {
    const checkpoint = checkpointChain.then(async () => {
      settledFindings.push(finding);
      settled++;
      recordFindings(ledger, [finding], nowIso, ledgerStats);
      await persistProgress({
        findings: [...settledFindings],
        stats,
        settled,
        total: toEvaluate.length,
        complete: false,
      });
    });
    checkpointChain = checkpoint;
    return checkpoint;
  };
  const evaluated = await evaluatePreparedSeeds(
    toEvaluate,
    family.label,
    concurrency,
    printOut,
    checkpointFinding,
  );
  const findings = [...cachedFindings, ...evaluated];

  // Step 4: only a fully settled scan may resolve or garbage-collect absent identities.
  finalizeLedgerFamily(
    ledger,
    findings,
    prepared,
    family.kind,
    nowIso,
    ledgerStats,
    partial === true,
    ledgerGcDays,
  );
  await persistProgress({
    findings,
    stats,
    settled,
    total: toEvaluate.length,
    complete: true,
  });

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
    let latestData: AuditReportData | undefined;
    let latestMarkdown = "";
    let savedPath: string | null = null;
    let reportedLivePath = false;
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
      const persistProgress = async (snapshot: AuditProgressSnapshot): Promise<void> => {
        const findings = [...allFindings, ...snapshot.findings];
        const evaluatedCount = findings.filter(
          (finding) => finding.ledger?.source !== "reused" && finding.ledger?.source !== "skipped",
        ).length;
        latestData = {
          generatedAt,
          workspaceRoot: getWorkspaceRoot(),
          detectors: [...detectors, snapshot.stats],
          ledger: ledgerStats,
          evaluatedCount,
          findings,
          progress: {
            status: snapshot.complete ? "complete" : "in-progress",
            settled: snapshot.settled,
            total: snapshot.total,
          },
          mcp: expectResource<McpAuditProvenanceCollector>(MCP_AUDIT_PROVENANCE_RESOURCE_KEY, {
            optional: true,
          })?.snapshot(),
        };
        latestMarkdown = renderAuditReport(latestData, { onlyActionable: props.onlyActionable });

        // Ledger first: a completed verdict must be reusable even if Markdown persistence is
        // best-effort. Both writes are serialized by processFamily's checkpoint chain.
        await saveAuditLedger(ledger, new Date().toISOString());
        savedPath = await persistAuditReport(latestMarkdown, generatedAt);
        if (savedPath && !reportedLivePath) {
          printOut(`[Audit] Live report: ${savedPath}\n`);
          reportedLivePath = true;
        }
      };

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
        persistProgress,
      );
      allFindings.push(...findings);
      detectors.push(stats);
    }

    if (!latestData) {
      throw new Error("Audit completed without producing a report checkpoint");
    }

    printOut("\n[Audit] Phase 3 — report finalized.\n");
    printOut(`\n${summarizeAuditReport(latestData, { onlyActionable: props.onlyActionable })}\n`);
    if (savedPath) {
      printOut(`[Audit] Report finalized at ${savedPath}\n`);
    }

    return latestMarkdown;
  },
});
