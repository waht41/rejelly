/**
 * Token-level duplicate-code candidate generation (INV-0008 Phase 1).
 * Public surface for the audit feature; internals stay in sibling modules.
 */

export {
  detectCloneCandidates,
  detectCloneCandidatesFromSources,
} from "./cloneCandidates";
export {
  type CloneCandidateReport,
  type CloneCandidateStats,
  type CloneCluster,
  type CloneDetectionConfig,
  type CloneFragment,
  DEFAULT_CLONE_CONFIG,
  type Fingerprint,
  type NormalizedToken,
} from "./types";
