/**
 * Fragmentation (over-decomposition) candidate generation (a Phase-1 detector for the audit feature,
 * INV-0008). First detector with a file-level import-graph input. Public surface; internals stay in
 * sibling modules.
 */

export {
  detectFragmentationCandidates,
  detectFragmentationCandidatesFromSources,
} from "./fragmentation";
export {
  buildImportGraph,
  extractRelativeSpecifiers,
  type FragmentationSource,
  type ImportGraph,
  resolveRelative,
} from "./importGraph";
export {
  DEFAULT_FRAGMENTATION_CONFIG,
  type FragmentationCandidateReport,
  type FragmentationCandidateStats,
  type FragmentationCluster,
  type FragmentationDetectionConfig,
  type FragmentationMember,
} from "./types";
