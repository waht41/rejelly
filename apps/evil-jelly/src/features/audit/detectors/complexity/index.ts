/**
 * Function-complexity candidate generation (a Phase-1 detector for the audit feature, INV-0008).
 * Public surface; internals stay in sibling modules.
 */

export {
  detectComplexityCandidates,
  detectComplexityCandidatesFromSources,
} from "./complexity";
export {
  type ComplexityCandidateReport,
  type ComplexityCandidateStats,
  type ComplexityDetectionConfig,
  type ComplexityFinding,
  type ComplexityMetrics,
  DEFAULT_COMPLEXITY_CONFIG,
} from "./types";
