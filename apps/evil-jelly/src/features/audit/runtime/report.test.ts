import { describe, expect, it } from "vitest";
import type {
  AuditFamilyStats,
  AuditFinding,
  AuditFindingKind,
  AuditReportData,
  AuditSeed,
  SeedVerdict,
} from "../types";
import { renderAuditReport, summarizeAuditReport } from "./report";

function seed(id: string, files: string[], kind: AuditFindingKind = "clone"): AuditSeed {
  return {
    kind,
    id,
    locations: files.map((file, i) => ({
      file,
      startLine: 10 + i,
      endLine: 30 + i,
      lines: 21,
    })),
    fileCount: files.length,
    weight: 21,
    label: `${files.length} fragment(s) · ${files.length} file(s)`,
  };
}

function verdict(over: Partial<SeedVerdict>): SeedVerdict {
  return {
    isActionable: true,
    severity: "medium",
    category: "extract-function",
    summary: "Shared retry loop duplicated",
    rationale: "Both copies implement the same backoff.",
    proposal: "Extract into shared/lib/retry.ts.",
    ...over,
  };
}

function detector(over: Partial<AuditFamilyStats> = {}): AuditFamilyStats {
  return {
    kind: "clone",
    label: "Code duplication",
    filesScanned: 100,
    filesParsed: 98,
    candidatesFound: 0,
    preFiltered: 0,
    ...over,
  };
}

function data(findings: AuditFinding[]): AuditReportData {
  return {
    generatedAt: "2026-06-28T00:00:00.000Z",
    workspaceRoot: "/ws",
    detectors: [detector({ candidatesFound: findings.length })],
    ledger: {
      loaded: 0,
      reused: 0,
      skippedSuppressed: 0,
      updated: 0,
      resolved: 0,
      pruned: 0,
    },
    evaluatedCount: findings.length,
    findings,
  };
}

describe("renderAuditReport", () => {
  it("ranks real high-severity findings before non-actionable ones", () => {
    const findings: AuditFinding[] = [
      {
        seed: seed("aaa", ["src/a.ts", "src/b.ts"]),
        verdict: verdict({ isActionable: false, severity: "low", category: "leave-as-is" }),
      },
      {
        seed: seed("bbb", ["src/c.ts", "src/d.ts"]),
        verdict: verdict({ severity: "high", summary: "Critical dup" }),
      },
    ];
    const md = renderAuditReport(data(findings));

    expect(md).toContain("# Architecture Audit");
    expect(md).toContain("actionable: 1 (high 1, medium 0, low 0)");
    // High-severity real finding must appear before the not-actionable one.
    expect(md.indexOf("Critical dup")).toBeLessThan(md.indexOf("not-actionable"));
    expect(md).toContain("**Proposal:** Extract into shared/lib/retry.ts.");
    expect(md).toContain("`src/c.ts:10-30`");
  });

  it("renders complexity-family findings with their kind tag", () => {
    const complexitySeed: AuditSeed = {
      kind: "complexity",
      id: "complexity:abc",
      locations: [{ file: "src/big.ts", startLine: 1, endLine: 240, lines: 240 }],
      fileCount: 1,
      weight: 400,
      label: "handleRequest — 240 lines, depth 6, cc 31, 3 param(s)",
    };
    const findings: AuditFinding[] = [
      {
        seed: complexitySeed,
        verdict: verdict({
          severity: "high",
          category: "extract-helpers",
          summary: "handleRequest does too much",
          proposal: "Split into parse/validate/dispatch helpers.",
        }),
      },
    ];
    const report = data(findings);
    report.detectors = [
      detector({ kind: "complexity", label: "Function complexity", candidatesFound: 1 }),
    ];
    const md = renderAuditReport(report);

    expect(md).toContain("· complexity · extract-helpers");
    expect(md).toContain("handleRequest — 240 lines");
    expect(md).toContain("Function complexity: scanned 100 files");
  });

  it("renders detector warnings in the report header", () => {
    const report = data([]);
    report.detectors = [
      detector({
        kind: "doc-drift",
        label: "API doc drift",
        filesScanned: 2,
        filesParsed: 1,
        warnings: ["Doc map entry points to missing document: docs/missing.md"],
      }),
    ];

    const md = renderAuditReport(report);

    expect(md).toContain("API doc drift: scanned 2 files (parsed 1), 0 candidate(s), 1 warning(s)");
    expect(md).toContain("Warning: Doc map entry points to missing document: docs/missing.md");
  });

  it("groups rendered findings by family", () => {
    const findings: AuditFinding[] = [
      {
        seed: seed("clone:a", ["src/a.ts", "src/b.ts"], "clone"),
        verdict: verdict({ summary: "Shared retry helper duplicated" }),
      },
      {
        seed: seed("fragmentation:a", ["src/host.ts", "src/tiny.ts"], "fragmentation"),
        verdict: verdict({
          severity: "low",
          category: "merge-into-host",
          summary: "Tiny single-consumer module split out",
        }),
      },
    ];
    const report = data(findings);
    report.detectors = [
      detector({ kind: "clone", label: "Code duplication", candidatesFound: 1 }),
      detector({ kind: "fragmentation", label: "Over-decomposition", candidatesFound: 1 }),
    ];
    const md = renderAuditReport(report);

    expect(md).toContain("### Code duplication (clone)");
    expect(md).toContain("### Over-decomposition (fragmentation)");
    expect(md.indexOf("Shared retry helper duplicated")).toBeLessThan(
      md.indexOf("Tiny single-consumer module split out"),
    );
  });

  it("renders a verdict details block between rationale and proposal", () => {
    const table =
      "**Sections:**\n\n| Section | Grade | Note |\n| --- | --- | --- |\n| Intro | ok |  |";
    const findings: AuditFinding[] = [
      {
        seed: seed("pair:guide.md", ["docs/zh/guide.md", "docs/en/guide.md"], "doc-sync"),
        verdict: verdict({
          category: "content-drift",
          summary: "guide.md drifted",
          details: table,
        }),
      },
    ];
    const md = renderAuditReport(data(findings));

    expect(md).toContain(table);
    expect(md.indexOf("**Why:**")).toBeLessThan(md.indexOf("**Sections:**"));
    expect(md.indexOf("**Sections:**")).toBeLessThan(md.indexOf("**Proposal:**"));
  });

  it("can render only actionable findings", () => {
    const findings: AuditFinding[] = [
      {
        seed: seed("real", ["src/a.ts", "src/b.ts"]),
        verdict: verdict({ summary: "Shared retry helper duplicated" }),
      },
      {
        seed: seed("noise", ["src/c.ts", "src/d.ts"]),
        verdict: verdict({
          isActionable: false,
          severity: "low",
          category: "leave-as-is",
          summary: "Repeated test fixture shape",
        }),
      },
      { seed: seed("err", ["src/e.ts", "src/f.ts"]), error: "model timeout" },
    ];
    const md = renderAuditReport(data(findings), { onlyActionable: true });

    expect(md).toContain("- Report filters: actionable findings only");
    expect(md).toContain("actionable: 1 (high 0, medium 1, low 0) · errored: 1");
    expect(md).toContain("Shared retry helper duplicated");
    expect(md).not.toContain("Repeated test fixture shape");
    expect(md).not.toContain("model timeout");
  });

  it("keeps suppressed unchanged ledger hits out of the findings body", () => {
    const findings: AuditFinding[] = [
      {
        seed: seed("suppressed", ["src/a.ts", "src/b.ts"]),
        verdict: verdict({
          isActionable: false,
          severity: "low",
          category: "leave-as-is",
          summary: "Repeated framework shape",
        }),
        ledger: { source: "skipped", status: "suppressed", reason: "not actionable" },
      },
    ];
    const report = data(findings);
    report.ledger = { ...report.ledger!, skippedSuppressed: 1 };
    report.evaluatedCount = 0;
    const md = renderAuditReport(report);

    expect(md).toContain("suppressed 1");
    expect(md).toContain("No new or active findings");
    expect(md).not.toContain("## Findings");
    expect(summarizeAuditReport(report)).toContain("1 suppressed by ledger");
  });

  it("renders an actionable-only empty state when all active findings are hidden", () => {
    const findings: AuditFinding[] = [
      {
        seed: seed("noise", ["src/a.ts", "src/b.ts"]),
        verdict: verdict({
          isActionable: false,
          severity: "low",
          category: "leave-as-is",
          summary: "Repeated framework shape",
        }),
      },
    ];
    const md = renderAuditReport(data(findings), { onlyActionable: true });

    expect(md).toContain("_No actionable findings to render.");
    expect(md).not.toContain("Repeated framework shape");
  });

  it("renders an empty-state report when there are no findings", () => {
    const md = renderAuditReport(data([]));
    expect(md).toContain("_No audit candidates were found._");
  });

  it("surfaces evaluation errors without a verdict", () => {
    const findings: AuditFinding[] = [
      { seed: seed("err", ["src/x.ts", "src/y.ts"]), error: "model timeout" },
    ];
    const md = renderAuditReport(data(findings));
    expect(md).toContain("evaluation failed");
    expect(md).toContain("model timeout");
  });
});

describe("summarizeAuditReport", () => {
  it("counts actionable findings", () => {
    const findings: AuditFinding[] = [
      { seed: seed("a", ["src/a.ts", "src/b.ts"]), verdict: verdict({}) },
      {
        seed: seed("b", ["src/c.ts", "src/d.ts"]),
        verdict: verdict({ isActionable: false, category: "leave-as-is" }),
      },
    ];
    expect(summarizeAuditReport(data(findings))).toContain("1 actionable");
  });

  it("mentions actionable-only report filtering", () => {
    expect(summarizeAuditReport(data([]), { onlyActionable: true })).toContain(
      "report filtered to actionable findings",
    );
  });
});
