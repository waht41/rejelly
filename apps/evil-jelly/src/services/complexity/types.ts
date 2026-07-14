/**
 * Shared types and tunable config for function-complexity candidate generation.
 *
 * This is a second Phase-1 detector for the architecture-audit topology (INV-0008), orthogonal to
 * the clone detector: clone finds the *same* logic in several places (cross-fragment similarity);
 * complexity finds a *single* function that is too large / deeply nested / over-branched to read.
 * Deterministic and zero-LLM — it only produces candidates with metrics; deciding whether (and how)
 * to decompose one is the per-seed evaluator's job (Phase 2).
 */

/** Cheap, deterministic size/shape metrics for one function-like node. */
export interface ComplexityMetrics {
  /** Source line span (endLine - startLine + 1). */
  lines: number;
  /** Maximum control-flow nesting depth inside the function body. */
  maxDepth: number;
  /** Cyclomatic-complexity proxy: 1 + decision points (if/loop/case/catch/ternary/&&/||/??). */
  branches: number;
  /** Declared parameter count. */
  params: number;
}

/** One function that crossed at least one complexity threshold: a refactor candidate. */
export interface ComplexityFinding {
  /** Stable-within-run id derived from file + name + position. */
  id: string;
  /** Workspace-relative posix path. */
  file: string;
  /** Best-effort function name (`(anonymous)` when it cannot be recovered). */
  name: string;
  /** 1-based inclusive start line of the function node. */
  startLine: number;
  /** 1-based inclusive end line of the function node. */
  endLine: number;
  metrics: ComplexityMetrics;
  /** Human-readable threshold crossings, e.g. `"240 lines ≥ 60"`. */
  reasons: string[];
  /** Composite ranking score (higher = worse). */
  score: number;
}

export interface ComplexityCandidateStats {
  filesScanned: number;
  filesParsed: number;
  /** Function-like nodes inspected across all parsed files. */
  functionsAnalyzed: number;
  /** Findings before the {@link ComplexityDetectionConfig.maxFindings} cap. */
  findingsBeforeCap: number;
}

export interface ComplexityCandidateReport {
  /** Candidates ranked worst-first, capped at {@link ComplexityDetectionConfig.maxFindings}. */
  findings: ComplexityFinding[];
  stats: ComplexityCandidateStats;
  config: ComplexityDetectionConfig;
}

/** Tunable thresholds for complexity detection. All have defaults in {@link DEFAULT_COMPLEXITY_CONFIG}. */
export interface ComplexityDetectionConfig {
  /** Flag a function whose line span reaches this. */
  maxLines: number;
  /** Flag a function whose control-flow nesting reaches this. */
  maxDepth: number;
  /** Flag a function whose cyclomatic proxy reaches this. */
  maxBranches: number;
  /** Flag a function with at least this many parameters. */
  maxParams: number;
  /** Floor: never flag a function shorter than this regardless of other metrics (drops trivia). */
  minLines: number;
  /** Max findings returned in the report. */
  maxFindings: number;
  /** Drop functions in test/fixture/generated paths (intentional bulk, not refactor targets). */
  excludeTestAndGenerated: boolean;
}

export const DEFAULT_COMPLEXITY_CONFIG: ComplexityDetectionConfig = {
  maxLines: 60,
  maxDepth: 4,
  maxBranches: 12,
  maxParams: 6,
  minLines: 12,
  maxFindings: 100,
  excludeTestAndGenerated: true,
};
