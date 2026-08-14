/**
 * Shared types and tunable config for fragmentation (over-decomposition) candidate generation.
 *
 * This is the third Phase-1 detector for the architecture-audit topology (INV-0008) and the first one
 * with a *graph* input: clone (token AST · similarity · merge) and complexity (function metrics · size ·
 * split) cannot produce this signal — it lives in the file-level import graph. The smell is a single
 * responsibility chopped into several tiny files, each imported by only one sibling/parent in the same
 * feature ("role split"): a host file plus private satellites that were spun out into their own modules.
 *
 * Detection needs only feature-internal *relative* import edges (`./` / `../`); the hard part of import
 * resolution (tsconfig aliases, node_modules) is exactly what this smell does not care about, so v1 needs
 * no resolver and no jelly-lint graph export. Deterministic and zero-LLM: it emits *candidate* clusters;
 * deciding whether (and how far) to merge is the per-seed evaluator's job (Phase 2). Unlike clone/complexity
 * the detector is honestly fuzzier here — "should these collapse?" is a judgment call, so candidates are
 * closer to questions than confirmed hits and the precision layer carries more weight.
 */

/** One file participating in a fragmentation cluster. */
export interface FragmentationMember {
  /** Workspace-relative posix path. */
  file: string;
  /** Source line count of the whole file. */
  lines: number;
  /** Number of distinct files that import this member via a relative edge. */
  importerCount: number;
  /** True for the consumer/host the satellites collapse into; false for a satellite. */
  isHost: boolean;
}

/**
 * A host file plus the single-consumer satellites it (transitively) owns: one over-decomposition
 * candidate. Members are the connected component of the "micro file → its unique near consumer" graph.
 */
export interface FragmentationCluster {
  /** Stable id derived from the sorted member file set. */
  id: string;
  /** The consumer/host file the satellites could merge into. */
  host: string;
  /** All files in the cluster (host + satellites), sorted by path. */
  members: FragmentationMember[];
  /** Distinct files touched (== members.length). */
  fileCount: number;
  /** Satellite count (members minus the host). */
  satelliteCount: number;
  /** Combined source line count across all members. */
  totalLines: number;
  /** Ranking strength (higher = stronger fragmentation signal). */
  score: number;
}

export interface FragmentationCandidateStats {
  filesScanned: number;
  filesParsed: number;
  /** Resolved feature-internal relative import edges. */
  edgesResolved: number;
  /** Clusters meeting the structural threshold, before any family pre-filter. */
  clustersFound: number;
}

export interface FragmentationCandidateReport {
  /** Candidate clusters, ranked strongest-first, capped at {@link FragmentationDetectionConfig.maxClusters}. */
  clusters: FragmentationCluster[];
  stats: FragmentationCandidateStats;
  config: FragmentationDetectionConfig;
}

/** Tunable knobs for fragmentation detection. All have defaults in {@link DEFAULT_FRAGMENTATION_CONFIG}. */
export interface FragmentationDetectionConfig {
  /** A file counts as a "micro" satellite only when its line count is at most this. */
  maxFileLines: number;
  /** Minimum total files (host + satellites) for a cluster to be reportable. */
  minClusterFiles: number;
  /** Max clusters returned in the report. */
  maxClusters: number;
  /** Drop test/fixture/generated paths from the graph (intentional structure, not refactor targets). */
  excludeTestAndGenerated: boolean;
}

export const DEFAULT_FRAGMENTATION_CONFIG: FragmentationDetectionConfig = {
  maxFileLines: 80,
  minClusterFiles: 2,
  maxClusters: 100,
  excludeTestAndGenerated: true,
};
