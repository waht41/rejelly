/**
 * Fan-in (Phase 3): aggregate per-seed verdicts from every family into one ranked Markdown report and
 * persist it under `.evil-jelly/audit/`. Cross-seed dedup within a family is handled upstream by the
 * deterministic detectors; a persistent architecture-spec/drift baseline is intentionally out of scope.
 */

import { getWorkspaceFsPolicy } from "../../../shared/fs-policy/workspace-fs-policy";
import type {
  AuditFinding,
  AuditFindingKind,
  AuditReportData,
  AuditReportRenderOptions,
  SeedVerdict,
} from "../types";

const SEVERITY_RANK: Record<SeedVerdict["severity"], number> = { high: 0, medium: 1, low: 2 };

function isSuppressedSkip(finding: AuditFinding): boolean {
  return finding.ledger?.source === "skipped" && finding.ledger.status === "suppressed";
}

/** Real findings first, by severity then strength; non-actionable and errored seeds sink down. */
function rankFindings(findings: AuditFinding[]): AuditFinding[] {
  return [...findings].sort((a, b) => {
    const aReal = a.verdict?.isActionable ? 0 : 1;
    const bReal = b.verdict?.isActionable ? 0 : 1;
    if (aReal !== bReal) {
      return aReal - bReal;
    }
    const aSev = a.verdict ? SEVERITY_RANK[a.verdict.severity] : 3;
    const bSev = b.verdict ? SEVERITY_RANK[b.verdict.severity] : 3;
    if (aSev !== bSev) {
      return aSev - bSev;
    }
    return b.seed.weight - a.seed.weight;
  });
}

function renderLocationList(finding: AuditFinding): string {
  return finding.seed.locations
    .map((l) => `  - \`${l.file}:${l.startLine}-${l.endLine}\` (${l.lines} lines)`)
    .join("\n");
}

function renderFinding(finding: AuditFinding, index: number, headingLevel = 3): string {
  const { seed, verdict, error } = finding;
  const heading = "#".repeat(headingLevel);
  if (error || !verdict) {
    return (
      `${heading} ${index}. ${seed.kind} \`${seed.id}\` — evaluation failed\n` +
      `${renderLocationList(finding)}\n\n` +
      `> ${error ?? "unknown error"}`
    );
  }
  const badge = verdict.isActionable
    ? `**${verdict.severity.toUpperCase()}** · ${seed.kind} · ${verdict.category}`
    : `not-actionable · ${seed.kind} · ${verdict.category}`;
  const ledgerSuffix =
    finding.ledger?.source === "reused" ? ` · ledger reused (${finding.ledger.status})` : "";
  return [
    `${heading} ${index}. ${verdict.summary}`,
    `${badge} · ${seed.label}${ledgerSuffix}`,
    "",
    renderLocationList(finding),
    "",
    `**Why:** ${verdict.rationale}`,
    verdict.details !== undefined && verdict.details.trim().length > 0
      ? `\n${verdict.details}`
      : "",
    verdict.proposal.trim().length > 0 ? `\n**Proposal:** ${verdict.proposal}` : "",
  ]
    .filter((s) => s !== "")
    .join("\n");
}

function detectorLabelByKind(data: AuditReportData): Map<AuditFindingKind, string> {
  return new Map(data.detectors.map((d) => [d.kind, d.label]));
}

function orderedFindingKinds(ranked: AuditFinding[], data: AuditReportData): AuditFindingKind[] {
  const seen = new Set<AuditFindingKind>();
  const ordered: AuditFindingKind[] = [];
  for (const detector of data.detectors) {
    if (ranked.some((finding) => finding.seed.kind === detector.kind)) {
      seen.add(detector.kind);
      ordered.push(detector.kind);
    }
  }
  for (const finding of ranked) {
    if (!seen.has(finding.seed.kind)) {
      seen.add(finding.seed.kind);
      ordered.push(finding.seed.kind);
    }
  }
  return ordered;
}

function renderFindingSections(ranked: AuditFinding[], data: AuditReportData): string {
  const labels = detectorLabelByKind(data);
  return orderedFindingKinds(ranked, data)
    .map((kind) => {
      const findings = ranked.filter((finding) => finding.seed.kind === kind);
      const rendered = findings.map((finding, i) => renderFinding(finding, i + 1, 4));
      return [`### ${labels.get(kind) ?? kind} (${kind})`, ...rendered].join("\n\n");
    })
    .join("\n\n---\n\n");
}

function renderDetectorLines(data: AuditReportData): string[] {
  if (data.detectors.length === 0) {
    return [];
  }
  const lines = ["- Detectors:"];
  for (const d of data.detectors) {
    lines.push(
      `  - ${d.label}: scanned ${d.filesScanned} files (parsed ${d.filesParsed}), ` +
        `${d.candidatesFound} candidate(s)` +
        (d.preFiltered > 0 ? `, ${d.preFiltered} pre-filtered` : "") +
        (d.warnings && d.warnings.length > 0 ? `, ${d.warnings.length} warning(s)` : ""),
    );
    for (const warning of d.warnings ?? []) {
      lines.push(`    - Warning: ${warning}`);
    }
  }
  return lines;
}

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

/** Render the full audit report as Markdown. */
export function renderAuditReport(
  data: AuditReportData,
  options: AuditReportRenderOptions = {},
): string {
  const suppressedSkipped = data.findings.filter(isSuppressedSkip).length;
  const activeRanked = rankFindings(data.findings.filter((finding) => !isSuppressedSkip(finding)));
  const ranked = options.onlyActionable
    ? activeRanked.filter((finding) => finding.verdict?.isActionable)
    : activeRanked;
  const real = activeRanked.filter((f) => f.verdict?.isActionable);
  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const f of real) {
    if (f.verdict) {
      bySeverity[f.verdict.severity]++;
    }
  }
  const errored = activeRanked.filter((f) => f.error).length;

  const header = [
    "# Architecture Audit",
    "",
    `- Generated: ${data.generatedAt}`,
    `- Workspace: \`${data.workspaceRoot}\``,
    ...(data.mcp && data.mcp.length > 0
      ? [
          "- MCP provenance:",
          ...data.mcp.map(
            (entry) =>
              `  - ${entry.serverId}: config ${entry.configFingerprint}, catalog ${entry.catalogRevision}`,
          ),
        ]
      : []),
    ...renderDetectorLines(data),
    options.onlyActionable ? "- Report filters: actionable findings only" : false,
    data.ledger
      ? `- Ledger: loaded ${data.ledger.loaded}, reused ${data.ledger.reused}, ` +
        `suppressed ${data.ledger.skippedSuppressed}, updated ${data.ledger.updated}, ` +
        `resolved ${data.ledger.resolved}, pruned ${data.ledger.pruned}`
      : false,
    `- Evaluated: ${data.evaluatedCount} · actionable: ${real.length} ` +
      `(high ${bySeverity.high}, medium ${bySeverity.medium}, low ${bySeverity.low})` +
      (errored > 0 ? ` · errored: ${errored}` : ""),
  ]
    .filter((line) => line !== false)
    .join("\n");

  if (data.findings.length === 0) {
    return `${header}\n\n_No audit candidates were found._\n`;
  }
  if (activeRanked.length === 0) {
    return (
      `${header}\n\n` +
      `_No new or active findings. ${suppressedSkipped} suppressed unchanged candidate(s) ` +
      `were skipped by the audit ledger._\n`
    );
  }
  if (ranked.length === 0) {
    const hidden = activeRanked.length;
    return (
      `${header}\n\n` +
      `_No actionable findings to render. ${hidden} non-actionable or errored candidate(s) ` +
      `were hidden by --only-actionable._\n`
    );
  }

  const sections = renderFindingSections(ranked, data);
  return `${header}\n\n## Findings\n\n${sections}\n`;
}

/** One-line console summary for the host after a run. */
export function summarizeAuditReport(
  data: AuditReportData,
  options: AuditReportRenderOptions = {},
): string {
  const active = data.findings.filter((finding) => !isSuppressedSkip(finding));
  const real = active.filter((f) => f.verdict?.isActionable).length;
  const candidates = data.detectors.reduce((sum, d) => sum + d.candidatesFound, 0);
  const reportFilter = options.onlyActionable ? ", report filtered to actionable findings" : "";
  return (
    `Audit complete: ${candidates} candidate(s), ` +
    `${data.evaluatedCount} evaluated, ${real} actionable finding(s)${reportFilter}` +
    (data.ledger && data.ledger.skippedSuppressed > 0
      ? `, ${data.ledger.skippedSuppressed} suppressed by ledger`
      : "") +
    (data.ledger && data.ledger.pruned > 0
      ? `, ${data.ledger.pruned} stale ledger ${pluralize(data.ledger.pruned, "entry", "entries")} pruned.`
      : ".")
  );
}

/**
 * Persist the report under `.evil-jelly/audit/`. Best-effort: returns the workspace-relative path on
 * success, or null when the write fails (the report is also returned to the caller regardless).
 */
export async function persistAuditReport(
  markdown: string,
  generatedAt: string,
): Promise<string | null> {
  const policy = getWorkspaceFsPolicy();
  const stamp = generatedAt.replace(/[:.]/g, "-");
  const relPath = `.evil-jelly/audit/audit-${stamp}.md`;
  try {
    await policy.mkdir(".evil-jelly/audit", { recursive: true });
    await policy.writeFile(relPath, markdown);
    return relPath;
  } catch {
    return null;
  }
}
