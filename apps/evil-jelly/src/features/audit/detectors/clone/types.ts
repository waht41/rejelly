/**
 * Shared types and tunable config for token-level clone (duplicate-code) candidate generation.
 *
 * This is Phase 1 of the architecture-audit topology (INV-0008): a deterministic, zero-LLM
 * fan-out that produces *candidate* duplicate clusters as seeds. It targets Type-1/Type-2 clones
 * (textual + renamed identifiers/literals); semantic duplication is out of scope here and belongs
 * to a later embedding pass.
 */

/** A normalized token: its placeholder text plus the 1-based source line it starts on. */
export interface NormalizedToken {
  /** Normalized lexeme: `$ID` for identifiers, `$LIT` for literals, else the raw punctuation/keyword. */
  norm: string;
  /** 1-based source line of the token's first character. */
  line: number;
}

/** One winnowed k-gram fingerprint anchored at a token position within a single file. */
export interface Fingerprint {
  /** 32-bit rolling hash of the k-gram starting at {@link tokenPos}. */
  hash: number;
  /** Index of the first token of the k-gram in the file's token stream. */
  tokenPos: number;
  /** 1-based line of the k-gram's first token. */
  startLine: number;
  /** 1-based line of the k-gram's last token. */
  endLine: number;
}

/** A contiguous duplicated region within one file. */
export interface CloneFragment {
  /** Workspace-relative posix path. */
  file: string;
  /** 1-based inclusive start line. */
  startLine: number;
  /** 1-based inclusive end line. */
  endLine: number;
  /** Line span (endLine - startLine + 1). */
  lines: number;
}

/** A group of >=2 mutually-similar fragments: one duplicate-code candidate. */
export interface CloneCluster {
  /** Stable id derived from the sorted fragment keys. */
  id: string;
  /** The duplicated fragments (always >=2). */
  fragments: CloneFragment[];
  /** Distinct files touched by this cluster. */
  fileCount: number;
  /** Largest fragment line span in the cluster (a cheap strength signal). */
  maxLines: number;
  /** Strongest pairwise shared-fingerprint count backing this cluster. */
  sharedFingerprints: number;
}

export interface CloneCandidateStats {
  filesScanned: number;
  filesParsed: number;
  /** Distinct fragments across all clusters before the prefilter. */
  clustersBeforeFilter: number;
  clustersAfterFilter: number;
}

export interface CloneCandidateReport {
  /** Candidate clusters, ranked strongest-first, capped at {@link CloneDetectionConfig.maxClusters}. */
  clusters: CloneCluster[];
  stats: CloneCandidateStats;
  config: CloneDetectionConfig;
}

/** Tunable knobs for clone detection. All have defaults in {@link DEFAULT_CLONE_CONFIG}. */
export interface CloneDetectionConfig {
  /** k-gram size in tokens (granularity of a match unit). */
  k: number;
  /** Winnowing window: guarantees detection of any shared token run of length >= w + k - 1. */
  windowSize: number;
  /** Minimum shared fingerprints for a file-pair match to count as a clone. */
  minSharedFingerprints: number;
  /** Minimum line span for a fragment to be reportable (drops tiny matches). */
  minLines: number;
  /**
   * A fingerprint occurring in more than this many distinct files is treated as boilerplate
   * noise and excluded from matching (cheap "worth investigating" gate, INV-0008 §2.3).
   */
  maxFingerprintFileFreq: number;
  /** Hard cap on file pairs examined (bounds the O(pairs) matching work). */
  maxFilePairs: number;
  /** Hard cap on anchor matches considered per file pair. */
  maxAnchorsPerPair: number;
  /** Max clusters returned in the report. */
  maxClusters: number;
  /**
   * When true, drop clusters whose every fragment lives in a test/fixture/generated path.
   * Such clones are usually intentional boilerplate, not refactor targets.
   */
  excludeTestAndGenerated: boolean;
}

export const DEFAULT_CLONE_CONFIG: CloneDetectionConfig = {
  k: 12,
  windowSize: 8,
  minSharedFingerprints: 4,
  minLines: 5,
  maxFingerprintFileFreq: 40,
  maxFilePairs: 20_000,
  maxAnchorsPerPair: 4_000,
  maxClusters: 100,
  excludeTestAndGenerated: true,
};
