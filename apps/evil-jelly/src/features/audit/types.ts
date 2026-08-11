/**
 * Types for the architecture-audit agent (INV-0008). The audit runs one or more deterministic
 * Phase-1 detectors ("seed families" — token-level clone, function complexity, …), each feeding the
 * same agentic per-seed precision layer and the same shared ledger.
 *
 * Topology per family: deterministic seed fan-out → agentic per-seed evaluation (LLM tool loop,
 * judgment) → deterministic fan-in (aggregate + persist report). Detectors are recall-oriented and
 * *will* surface coincidental/boilerplate matches; the per-seed evaluator is the precision layer that
 * decides whether a candidate is actionable and proposes a concrete refactor.
 */

import type { AuditFindingKind } from "./contracts";

export type { AuditFindingKind } from "./contracts";

/** Detector/finding families. The ledger is shared; each family owns its identity + evaluator. */
export type AuditLedgerStatus = "open" | "accepted" | "suppressed" | "resolved";
export type AuditLedgerSource = "evaluated" | "reused" | "skipped";

/**
 * Family-agnostic verdict the per-seed evaluator returns. Each family validates with its own zod
 * schema (its own `category` enum + wording), but they share this stored/report shape.
 */
export interface SeedVerdict {
  /**
   * True only when this is a genuine, worth-acting finding. False for coincidental matches,
   * framework/boilerplate shape, or structure that is intentional / clearer left as-is.
   */
  isActionable: boolean;
  /** Refactor priority. Use `low` when `isActionable` is false. */
  severity: "high" | "medium" | "low";
  /** The refactor shape that best resolves this (family-specific vocabulary). */
  category: string;
  /** One sentence: what the issue is and where (no code, no fences). */
  summary: string;
  /** Why it is (or isn't) worth refactoring. */
  rationale: string;
  /** Concrete refactor plan when actionable; empty string otherwise. */
  proposal: string;
  /**
   * Optional family-specific evidence block, rendered verbatim (Markdown) in the report between
   * rationale and proposal — e.g. the doc-sync per-section grade table. Omit when prose suffices.
   */
  details?: string;
}

/** One code location a seed spans (clone: each fragment; complexity: the one function). */
export interface AuditCodeLocation {
  /** Workspace-relative posix path. */
  file: string;
  /** 1-based inclusive start line. */
  startLine: number;
  /** 1-based inclusive end line. */
  endLine: number;
  /** Line span. */
  lines: number;
}

/** Family-agnostic view of a detector candidate, used for ranking and reporting. */
export interface AuditSeed {
  kind: AuditFindingKind;
  /** Detector candidate id. */
  id: string;
  /** Locations this seed spans (always >=1). */
  locations: AuditCodeLocation[];
  /** Distinct files touched. */
  fileCount: number;
  /** Strength signal for secondary ranking within a family (higher = stronger). */
  weight: number;
  /** Short header label, e.g. `9 fragments · 3 files` or `handleRequest — 240 lines, depth 6`. */
  label: string;
}

export interface AuditSeedIdentity {
  /** Global finding id: `${kind}:${fingerprint}`. */
  id: string;
  /** Detector/finding family. Ledger stays shared; each family owns its identity adapter. */
  kind: AuditFindingKind;
  /** Stable enough to survive line moves; derived from paths + normalized code shape. */
  fingerprint: string;
  /** More sensitive snapshot used to decide whether a cached verdict still applies. */
  contentHash: string;
}

export interface AuditLedgerEntry extends AuditSeedIdentity {
  status: AuditLedgerStatus;
  firstSeen: string;
  lastSeen: string;
  lastEvaluatedAt?: string;
  resolvedAt?: string;
  lastVerdict?: SeedVerdict;
  lastVerdictHash?: string;
  suppressionReason?: string;
}

export interface AuditLedgerFile {
  version: 1;
  updatedAt: string;
  entries: Record<string, AuditLedgerEntry>;
}

/** One evaluated candidate: the family-agnostic seed plus the agent's verdict (or an error). */
export interface AuditFinding {
  seed: AuditSeed;
  identity?: AuditSeedIdentity;
  verdict?: SeedVerdict;
  /** Set when the per-seed evaluation failed (model/tool error); verdict is then undefined. */
  error?: string;
  ledger?: {
    source: AuditLedgerSource;
    status: AuditLedgerStatus;
    reason?: string;
  };
}

/** Per-family deterministic detector stats for the report header. */
export interface AuditFamilyStats {
  kind: AuditFindingKind;
  /** Human-readable family label, e.g. `Code duplication`. */
  label: string;
  filesScanned: number;
  filesParsed: number;
  /** Candidates the detector produced (before this family's pre-filter). */
  candidatesFound: number;
  /** Candidates dropped by the family's deterministic pre-filter (never sent to the LLM). */
  preFiltered: number;
  /** Non-fatal detector warnings surfaced in the audit report. */
  warnings?: string[];
}

export interface AuditReportData {
  generatedAt: string;
  workspaceRoot: string;
  /** Per-family detector stats. */
  detectors: AuditFamilyStats[];
  ledger?: {
    loaded: number;
    reused: number;
    skippedSuppressed: number;
    updated: number;
    resolved: number;
    pruned: number;
  };
  evaluatedCount: number;
  findings: AuditFinding[];
}

export interface AuditReportRenderOptions {
  /** Hide non-actionable verdicts and evaluation errors from the rendered findings body. */
  onlyActionable?: boolean;
}

/** One detector candidate, ready for the generic driver. */
export interface PreparedSeed {
  /** Family-agnostic view for ranking + reporting. */
  seed: AuditSeed;
  /** Stable ledger identity. */
  identity: AuditSeedIdentity;
  /** Evaluate the underlying native candidate (Phase 2). */
  evaluate: () => Promise<SeedVerdict>;
}

/** Per-run narrowing options passed into family collectors. */
export interface AuditCollectOptions {
  /** Restrict document validation to one doc file (basename or workspace-relative path). */
  docFilter?: string;
  /** Temporary code paths for a one-off document validation run. */
  docCodePaths?: string[];
}

/**
 * Extension point: add one `families/<kind>.ts` file unless a real boundary warrants a sibling,
 * return stable identities plus evaluators from `collect`, then register it in `AuditAgent.ts`.
 * Cover detector ordering, ledger reuse, and any new report shape with contract tests.
 */
export interface AuditSeedFamily {
  kind: AuditSeed["kind"];
  /** Human-readable label for the report header. */
  label: string;
  /**
   * Phase 1 + pre-filter + identity resolution. `partial: true` marks a narrowed scan (e.g.
   * docFilter): absent seeds must then NOT be marked resolved in the ledger.
   */
  collect: (
    options?: AuditCollectOptions,
  ) => Promise<{ prepared: PreparedSeed[]; stats: AuditFamilyStats; partial?: boolean }>;
}

/** Options for one audit run. */
export interface AuditAgentProps {
  /** The single detector family to run. */
  family: AuditFindingKind;
  /** Render only actionable findings in the persisted Markdown report. */
  onlyActionable?: boolean;
  /** Restrict doc-drift to one doc file (basename or workspace-relative path). */
  docFilter?: string;
  /** Temporary code paths for a one-off doc-drift run. */
  docCodePaths?: string[];
  /** Max candidate seeds per family to send to the LLM evaluator (cost gate). */
  maxSeeds?: number;
  /** Concurrency for the per-seed fan-out. */
  concurrency?: number;
  /** Delete stale same-family ledger entries not seen for this many days. */
  ledgerGcDays?: number;
  /** Disable stale ledger garbage collection for this run. */
  disableLedgerGc?: boolean;
}

/** Default cost/scope gates (INV-0008 §2.2 double-gate: seed count + per-seed budget). */
export const AUDIT_DEFAULTS = {
  /** LLM evaluator seed cap, applied per family. */
  maxSeeds: 24,
  /** Same-family stale ledger TTL. Keeps the shared ledger bounded without cross-family pruning. */
  ledgerGcDays: 30,
  /** Per-seed fan-out concurrency (unordered pool; deepseek allows ~2500 concurrent, so headroom
   * is large). Overridable via settings.jsonc `audit.concurrency`; this is the fallback. */
  concurrency: 12,
  /** Per-seed tool-loop step cap. A safety net against runaway loops, deliberately well above the
   * typical 2-5 turns: per-seed cost is governed by perSeedIntakeTokens (no new tool output once
   * spent), not by this cap, so complex seeds (e.g. cross-file clone evidence) get headroom. */
  perSeedMaxTurnSteps: 20,
  /** Per-seed read-only intake token budget (snippets are pre-embedded, so reads are optional). */
  perSeedIntakeTokens: 100_000,
  /** Max fragments embedded per cluster in the evaluator prompt. */
  maxFragmentsPerSeed: 6,
  /** Max source lines embedded per fragment. */
  maxFragmentLines: 80,
  /** Max source lines embedded for a complexity function body. */
  maxComplexityBodyLines: 200,
  /** Max member files embedded per fragmentation cluster in the evaluator prompt. */
  maxFragmentationFiles: 8,
  /** Max source lines embedded per fragmentation member file. */
  maxFragmentationMemberLines: 120,
  /** Max doc-section lines embedded in the doc-drift evaluator prompt. */
  maxDocSectionLines: 150,
  /** Max matched surface symbols embedded per doc section. */
  maxDocSymbolsPerSection: 12,
  /** Max JSDoc lines embedded per matched surface symbol. */
  maxDocJsdocLines: 12,
  /** Max signature lines embedded per matched surface symbol (interfaces keep their body). */
  maxDocSignatureLines: 40,
  /** Max lines embedded per doc-map artifact file (schemas, d.ts mirrors). */
  maxDocArtifactLines: 160,
  /** Max unmatched identifier mentions listed per doc section. */
  maxDocUnmatchedMentions: 20,
  /** Max lines embedded per side (primary / mirror) in the doc-sync pair evaluator prompt. */
  maxDocSyncLinesPerSide: 400,
} as const;
