import { describe, expect, it } from "vitest";
import type { AuditFinding, AuditLedgerFile, AuditSeedIdentity, SeedVerdict } from "../types";
import {
  decideLedgerReuse,
  markResolvedLedgerEntries,
  pruneStaleLedgerEntries,
  recordFindingInLedger,
  touchCurrentIdentity,
} from "./ledger";

function ledger(): AuditLedgerFile {
  return { version: 1, updatedAt: "2026-06-28T00:00:00.000Z", entries: {} };
}

function identity(over: Partial<AuditSeedIdentity> = {}): AuditSeedIdentity {
  return {
    id: "clone:abc",
    kind: "clone",
    fingerprint: "abc",
    contentHash: "content-1",
    ...over,
  };
}

function verdict(over: Partial<SeedVerdict> = {}): SeedVerdict {
  return {
    isActionable: false,
    severity: "low",
    category: "leave-as-is",
    summary: "Framework shape repeated",
    rationale: "This is boilerplate and is clearer left apart.",
    proposal: "",
    ...over,
  };
}

function finding(id: AuditSeedIdentity, v: SeedVerdict): AuditFinding {
  return {
    identity: id,
    seed: {
      kind: id.kind,
      id: "seed",
      locations: [],
      fileCount: 2,
      weight: 10,
      label: "test seed",
    },
    verdict: v,
    ledger: { source: "evaluated", status: "open" },
  };
}

describe("audit ledger lifecycle", () => {
  it("auto-suppresses non-actionable verdicts and skips unchanged repeats", () => {
    const l = ledger();
    const id = identity();
    expect(recordFindingInLedger(l, finding(id, verdict()), "2026-06-28T00:00:00.000Z")).toBe(true);

    expect(l.entries[id.id]?.status).toBe("suppressed");
    expect(l.entries[id.id]?.suppressionReason).toContain("boilerplate");

    const decision = decideLedgerReuse(l, id);
    expect(decision.action).toBe("skip");
    expect(decision.entry?.lastVerdict?.isActionable).toBe(false);
  });

  it("reuses unchanged actionable verdicts without suppressing them", () => {
    const l = ledger();
    const id = identity();
    recordFindingInLedger(
      l,
      finding(
        id,
        verdict({
          isActionable: true,
          severity: "high",
          category: "extract-module",
          summary: "Shared retry loop",
          proposal: "Extract retry helper.",
        }),
      ),
      "2026-06-28T00:00:00.000Z",
    );

    expect(l.entries[id.id]?.status).toBe("open");
    expect(decideLedgerReuse(l, id).action).toBe("reuse");
    expect(decideLedgerReuse(l, identity({ contentHash: "content-2" })).action).toBe("evaluate");
  });

  it("does not reuse legacy verdicts that predate isActionable", () => {
    const l = ledger();
    const id = identity();
    l.entries[id.id] = {
      ...id,
      status: "open",
      firstSeen: "t0",
      lastSeen: "t0",
      lastVerdict: {
        isRealDuplication: true,
        severity: "medium",
        category: "extract-function",
        summary: "Old clone verdict",
        rationale: "Old schema should be discarded.",
        proposal: "Re-evaluate with the current schema.",
      } as unknown as SeedVerdict,
    };

    expect(decideLedgerReuse(l, id).action).toBe("evaluate");
  });

  it("hashes verdicts independently of object key insertion order", () => {
    const l = ledger();
    const normal = verdict();
    const reordered = {
      proposal: normal.proposal,
      rationale: normal.rationale,
      summary: normal.summary,
      category: normal.category,
      severity: normal.severity,
      isActionable: normal.isActionable,
    } as SeedVerdict;
    const a = identity({ id: "clone:a", fingerprint: "a" });
    const b = identity({ id: "clone:b", fingerprint: "b" });

    recordFindingInLedger(l, finding(a, normal), "t0");
    recordFindingInLedger(l, finding(b, reordered), "t0");

    expect(l.entries[a.id]?.lastVerdictHash).toBe(l.entries[b.id]?.lastVerdictHash);
  });

  it("marks missing current-kind entries as resolved and revives touched ones", () => {
    const l = ledger();
    const current = identity({ id: "clone:current", fingerprint: "current" });
    const gone = identity({ id: "clone:gone", fingerprint: "gone" });
    recordFindingInLedger(l, finding(current, verdict({ isActionable: true })), "t0");
    recordFindingInLedger(l, finding(gone, verdict({ isActionable: true })), "t0");

    touchCurrentIdentity(l, current, "t1");
    const resolved = markResolvedLedgerEntries(l, new Set([current.id]), "clone", "t1");

    expect(resolved).toBe(1);
    expect(l.entries[current.id]?.status).toBe("open");
    expect(l.entries[current.id]?.lastSeen).toBe("t1");
    expect(l.entries[gone.id]?.status).toBe("resolved");
    expect(l.entries[gone.id]?.resolvedAt).toBe("t1");
  });

  it("prunes stale same-kind non-accepted entries only", () => {
    const l = ledger();
    const stale = identity({ id: "clone:stale", fingerprint: "stale" });
    const accepted = identity({ id: "clone:accepted", fingerprint: "accepted" });
    const otherKind = identity({
      id: "doc-sync:stale",
      kind: "doc-sync",
      fingerprint: "doc",
    });
    recordFindingInLedger(l, finding(stale, verdict()), "2026-01-01T00:00:00.000Z");
    recordFindingInLedger(
      l,
      finding(accepted, verdict({ isActionable: true })),
      "2026-01-01T00:00:00.000Z",
    );
    recordFindingInLedger(l, finding(otherKind, verdict()), "2026-01-01T00:00:00.000Z");
    l.entries[accepted.id] = { ...l.entries[accepted.id]!, status: "accepted" };

    const pruned = pruneStaleLedgerEntries(l, "clone", "2026-03-01T00:00:00.000Z", 30);

    expect(pruned).toBe(1);
    expect(l.entries[stale.id]).toBeUndefined();
    expect(l.entries[accepted.id]).toBeDefined();
    expect(l.entries[otherKind.id]).toBeDefined();
  });
});
