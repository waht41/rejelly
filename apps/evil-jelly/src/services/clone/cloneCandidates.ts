/**
 * Duplicate-code candidate generator (Phase 1 of the audit topology, INV-0008).
 *
 * Deterministic, zero-LLM: scan workspace scripts, winnow-fingerprint their normalized token
 * streams, match file pairs by shared fingerprints, extend matches into aligned fragments, then
 * union mutually-similar fragments into candidate clusters. A cheap prefilter drops tiny matches
 * and pure test/generated boilerplate so the downstream agent only investigates worthwhile seeds.
 *
 * Output is *candidates*, not verdicts: recall-oriented with a coarse strength signal. Judging
 * "is this worth extracting / where does the abstraction belong" is the agent's job (Phase 2).
 */

import {
  getWorkspaceFsPolicy,
  type WorkspaceFsPolicy,
} from "../../shared/fs-policy/workspace-fs-policy";
import { listWorkspaceScriptRelPaths } from "../../shared/fs-policy/workspace-paths";
import { tryParseRoot } from "../../shared/lib/ast-parse";
import { fnv1a32Hex } from "../../shared/lib/hash";
import { MAX_HEURISTIC_AST_BYTES } from "../../shared/lib/heuristicAstLimits";
import { isTestOrGeneratedPath } from "../../shared/lib/path";
import { fingerprintTokens } from "./fingerprint";
import { tokenizeNormalized } from "./tokenize";
import {
  type CloneCandidateReport,
  type CloneCluster,
  type CloneDetectionConfig,
  type CloneFragment,
  DEFAULT_CLONE_CONFIG,
  type Fingerprint,
} from "./types";

/** Max fingerprint-array index gap before a matched chain is split into separate fragments. */
const MAX_RUN_GAP = 3;
/** Line gap within which two fragments in the same file are merged into one canonical region. */
const MERGE_GAP_LINES = 2;

interface FileFingerprints {
  file: string;
  fps: Fingerprint[];
}

/** A maximal aligned match between a region of file A and a region of file B. */
interface ClonePair {
  a: CloneFragment;
  b: CloneFragment;
  sharedFingerprints: number;
}

/** Re-exported from shared so callers within the clone service keep a single import surface. */
export { isTestOrGeneratedPath };

// ---------------------------------------------------------------------------
// Union-Find over canonical fragment ids
// ---------------------------------------------------------------------------

class UnionFind {
  private readonly parent: number[] = [];

  make(): number {
    const id = this.parent.length;
    this.parent.push(id);
    return id;
  }

  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) {
      root = this.parent[root];
    }
    // Path compression.
    let cur = x;
    while (this.parent[cur] !== root) {
      const next = this.parent[cur];
      this.parent[cur] = root;
      cur = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) {
      this.parent[rb] = ra;
    }
  }
}

// ---------------------------------------------------------------------------
// Per-file-pair matching: shared fingerprints -> aligned fragments
// ---------------------------------------------------------------------------

/** Longest strictly-increasing subsequence of `seq`; returns the chosen indices (into `seq`). */
function longestIncreasingSubsequence(seq: number[]): number[] {
  const n = seq.length;
  if (n === 0) {
    return [];
  }
  const tails: number[] = []; // tails[len-1] = index in seq of the smallest tail for an LIS of that length
  const prev = new Int32Array(n).fill(-1);

  for (let i = 0; i < n; i++) {
    // Binary search for the first tail whose value >= seq[i] (strictly increasing).
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    if (lo > 0) {
      prev[i] = tails[lo - 1];
    }
    if (lo === tails.length) {
      tails.push(i);
    } else {
      tails[lo] = i;
    }
  }

  const out: number[] = [];
  let k = tails[tails.length - 1];
  while (k !== -1) {
    out.push(k);
    k = prev[k];
  }
  out.reverse();
  return out;
}

function fragmentFromRange(file: string, startLine: number, endLine: number): CloneFragment {
  return { file, startLine, endLine, lines: endLine - startLine + 1 };
}

/**
 * Match two files via their shared (non-common) fingerprints and extend the matches into aligned
 * fragments. Anchors are aligned with an LIS so the chain is monotonic in both files, then split
 * where either side has a discontinuity larger than {@link MAX_RUN_GAP}.
 */
function matchFilePair(
  fa: FileFingerprints,
  fb: FileFingerprints,
  commonHashes: Set<number>,
  config: CloneDetectionConfig,
): ClonePair[] {
  // hash -> indices in fb (skip common/noise hashes).
  const byHashB = new Map<number, number[]>();
  for (let j = 0; j < fb.fps.length; j++) {
    const h = fb.fps[j].hash;
    if (commonHashes.has(h)) {
      continue;
    }
    const list = byHashB.get(h);
    if (list) {
      list.push(j);
    } else {
      byHashB.set(h, [j]);
    }
  }
  if (byHashB.size === 0) {
    return [];
  }

  // Anchors (ia, ib). Sort by ia asc, ib desc so LIS on ib picks at most one ib per ia.
  const anchorsA: number[] = [];
  const anchorsB: number[] = [];
  for (let i = 0; i < fa.fps.length; i++) {
    const h = fa.fps[i].hash;
    if (commonHashes.has(h)) {
      continue;
    }
    const matches = byHashB.get(h);
    if (!matches) {
      continue;
    }
    for (let m = matches.length - 1; m >= 0; m--) {
      anchorsA.push(i);
      anchorsB.push(matches[m]);
      if (anchorsA.length >= config.maxAnchorsPerPair) {
        break;
      }
    }
    if (anchorsA.length >= config.maxAnchorsPerPair) {
      break;
    }
  }
  if (anchorsA.length === 0) {
    return [];
  }

  const chainIdx = longestIncreasingSubsequence(anchorsB);
  if (chainIdx.length < config.minSharedFingerprints) {
    return [];
  }

  // Split the monotonic chain into runs wherever either side jumps more than MAX_RUN_GAP.
  const pairs: ClonePair[] = [];
  let runStart = 0;
  const flush = (from: number, to: number): void => {
    const len = to - from;
    if (len < config.minSharedFingerprints) {
      return;
    }
    let aStart = Number.POSITIVE_INFINITY;
    let aEnd = 0;
    let bStart = Number.POSITIVE_INFINITY;
    let bEnd = 0;
    for (let t = from; t < to; t++) {
      const fpA = fa.fps[anchorsA[chainIdx[t]]];
      const fpB = fb.fps[anchorsB[chainIdx[t]]];
      aStart = Math.min(aStart, fpA.startLine);
      aEnd = Math.max(aEnd, fpA.endLine);
      bStart = Math.min(bStart, fpB.startLine);
      bEnd = Math.max(bEnd, fpB.endLine);
    }
    const a = fragmentFromRange(fa.file, aStart, aEnd);
    const b = fragmentFromRange(fb.file, bStart, bEnd);
    // Both sides must clear the size floor: weak, short matches are the bridges that
    // transitively over-merge unrelated code into useless mega-clusters.
    if (a.lines < config.minLines || b.lines < config.minLines) {
      return;
    }
    pairs.push({ a, b, sharedFingerprints: len });
  };

  for (let c = 1; c < chainIdx.length; c++) {
    const prevA = anchorsA[chainIdx[c - 1]];
    const prevB = anchorsB[chainIdx[c - 1]];
    const curA = anchorsA[chainIdx[c]];
    const curB = anchorsB[chainIdx[c]];
    if (curA - prevA > MAX_RUN_GAP || curB - prevB > MAX_RUN_GAP) {
      flush(runStart, c);
      runStart = c;
    }
  }
  flush(runStart, chainIdx.length);
  return pairs;
}

// ---------------------------------------------------------------------------
// Canonical fragments (merge overlapping per-file regions)
// ---------------------------------------------------------------------------

interface CanonicalFragments {
  /** Resolve a raw fragment to its canonical UnionFind id. */
  idOf(fragment: CloneFragment): number;
  /** All canonical fragments keyed by their UnionFind id. */
  fragments: Map<number, CloneFragment>;
}

/**
 * Merge raw fragments that overlap (or sit within {@link MERGE_GAP_LINES}) within a file into
 * canonical regions, each assigned a fresh UnionFind id. Returns a lookup from any raw fragment
 * back to the canonical id covering it.
 */
function buildCanonicalFragments(rawFragments: CloneFragment[], uf: UnionFind): CanonicalFragments {
  const byFile = new Map<string, CloneFragment[]>();
  for (const frag of rawFragments) {
    const list = byFile.get(frag.file);
    if (list) {
      list.push(frag);
    } else {
      byFile.set(frag.file, [frag]);
    }
  }

  const fragments = new Map<number, CloneFragment>();
  // file -> sorted array of merged intervals with their canonical id.
  const merged = new Map<string, Array<{ start: number; end: number; id: number }>>();

  for (const [file, frags] of byFile) {
    frags.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
    const intervals: Array<{ start: number; end: number; id: number }> = [];
    for (const frag of frags) {
      const last = intervals[intervals.length - 1];
      if (last && frag.startLine <= last.end + MERGE_GAP_LINES) {
        last.end = Math.max(last.end, frag.endLine);
        const canon = fragments.get(last.id);
        if (canon) {
          canon.endLine = last.end;
          canon.lines = canon.endLine - canon.startLine + 1;
        }
      } else {
        const id = uf.make();
        intervals.push({ start: frag.startLine, end: frag.endLine, id });
        fragments.set(id, fragmentFromRange(file, frag.startLine, frag.endLine));
      }
    }
    merged.set(file, intervals);
  }

  const idOf = (fragment: CloneFragment): number => {
    const intervals = merged.get(fragment.file);
    if (!intervals) {
      throw new Error(`No canonical interval for ${fragment.file}`);
    }
    for (const iv of intervals) {
      if (fragment.startLine >= iv.start && fragment.startLine <= iv.end) {
        return iv.id;
      }
    }
    // Fallback: nearest by start (merge may have grown an interval past this start).
    let best = intervals[0];
    for (const iv of intervals) {
      if (Math.abs(iv.start - fragment.startLine) < Math.abs(best.start - fragment.startLine)) {
        best = iv;
      }
    }
    return best.id;
  };

  return { idOf, fragments };
}

// ---------------------------------------------------------------------------
// Cluster id
// ---------------------------------------------------------------------------

function clusterId(fragments: CloneFragment[]): string {
  const key = fragments
    .map((f) => `${f.file}:${f.startLine}-${f.endLine}`)
    .sort()
    .join("|");
  return fnv1a32Hex(key);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Parse + tokenize + fingerprint one source. Null on parse failure or too few tokens. */
function fingerprintOne(
  file: string,
  code: string,
  config: CloneDetectionConfig,
): FileFingerprints | null {
  const root = tryParseRoot(file, code);
  if (!root) {
    return null;
  }
  const tokens = tokenizeNormalized(root);
  const fps = fingerprintTokens(tokens, config.k, config.windowSize);
  return fps.length > 0 ? { file, fps } : null;
}

/** Fingerprint every workspace script via a bounded read (skips files over the AST byte cap). */
async function fingerprintWorkspace(
  policy: WorkspaceFsPolicy,
  files: string[],
  config: CloneDetectionConfig,
): Promise<FileFingerprints[]> {
  const result: FileFingerprints[] = [];
  for (const file of files) {
    let code: string;
    try {
      const stat = await policy.stat(file);
      if (stat.size > MAX_HEURISTIC_AST_BYTES) {
        continue;
      }
      code = await policy.readAstFile(file);
    } catch {
      continue;
    }
    const fingerprinted = fingerprintOne(file, code, config);
    if (fingerprinted) {
      result.push(fingerprinted);
    }
  }
  return result;
}

/** Hashes appearing in more than `maxFingerprintFileFreq` files are boilerplate noise. */
function findCommonHashes(files: FileFingerprints[], config: CloneDetectionConfig): Set<number> {
  const fileFreq = new Map<number, number>();
  for (const f of files) {
    const seen = new Set<number>();
    for (const fp of f.fps) {
      if (!seen.has(fp.hash)) {
        seen.add(fp.hash);
        fileFreq.set(fp.hash, (fileFreq.get(fp.hash) ?? 0) + 1);
      }
    }
  }
  const common = new Set<number>();
  for (const [hash, freq] of fileFreq) {
    if (freq > config.maxFingerprintFileFreq) {
      common.add(hash);
    }
  }
  return common;
}

/**
 * Candidate file pairs: any two files sharing at least one non-common fingerprint. Bounded by
 * {@link CloneDetectionConfig.maxFilePairs}. Returned as ordered index pairs `[a, b]` with a < b.
 */
function findCandidateFilePairs(
  files: FileFingerprints[],
  commonHashes: Set<number>,
  config: CloneDetectionConfig,
): Array<[number, number]> {
  const byHash = new Map<number, number[]>(); // hash -> distinct fileIdx list
  for (let i = 0; i < files.length; i++) {
    const seen = new Set<number>();
    for (const fp of files[i].fps) {
      if (commonHashes.has(fp.hash) || seen.has(fp.hash)) {
        continue;
      }
      seen.add(fp.hash);
      const list = byHash.get(fp.hash);
      if (list) {
        list.push(i);
      } else {
        byHash.set(fp.hash, [i]);
      }
    }
  }

  const pairSet = new Set<number>();
  const pairs: Array<[number, number]> = [];
  for (const fileIdxs of byHash.values()) {
    if (fileIdxs.length < 2) {
      continue;
    }
    for (let x = 0; x < fileIdxs.length; x++) {
      for (let y = x + 1; y < fileIdxs.length; y++) {
        const a = fileIdxs[x];
        const b = fileIdxs[y];
        const key = a * files.length + b;
        if (pairSet.has(key)) {
          continue;
        }
        pairSet.add(key);
        pairs.push([a, b]);
        if (pairs.length >= config.maxFilePairs) {
          return pairs;
        }
      }
    }
  }
  return pairs;
}

/** Fingerprint already-loaded sources (IO-free). Files with too few tokens are skipped. */
function fingerprintSources(
  sources: Array<{ file: string; code: string }>,
  config: CloneDetectionConfig,
): FileFingerprints[] {
  const result: FileFingerprints[] = [];
  for (const { file, code } of sources) {
    const fingerprinted = fingerprintOne(file, code, config);
    if (fingerprinted) {
      result.push(fingerprinted);
    }
  }
  return result;
}

/** Core clustering over fingerprinted files: match pairs, extend, union, prefilter, rank. */
function clusterFingerprints(
  fingerprinted: FileFingerprints[],
  config: CloneDetectionConfig,
): { clusters: CloneCluster[]; clustersBeforeFilter: number } {
  const commonHashes = findCommonHashes(fingerprinted, config);
  const filePairs = findCandidateFilePairs(fingerprinted, commonHashes, config);

  const clonePairs: ClonePair[] = [];
  for (const [a, b] of filePairs) {
    clonePairs.push(...matchFilePair(fingerprinted[a], fingerprinted[b], commonHashes, config));
  }

  // Cluster: canonical fragments unioned by clone pairs.
  const uf = new UnionFind();
  const rawFragments: CloneFragment[] = [];
  for (const pair of clonePairs) {
    rawFragments.push(pair.a, pair.b);
  }
  const canonical = buildCanonicalFragments(rawFragments, uf);

  const pairStrengthByRoot = new Map<number, number>();
  for (const pair of clonePairs) {
    const ida = canonical.idOf(pair.a);
    const idb = canonical.idOf(pair.b);
    uf.union(ida, idb);
  }
  // Aggregate strength after union so roots are final.
  for (const pair of clonePairs) {
    const root = uf.find(canonical.idOf(pair.a));
    pairStrengthByRoot.set(
      root,
      Math.max(pairStrengthByRoot.get(root) ?? 0, pair.sharedFingerprints),
    );
  }

  // Group canonical fragments by component root.
  const byRoot = new Map<number, CloneFragment[]>();
  for (const [id, frag] of canonical.fragments) {
    const root = uf.find(id);
    const list = byRoot.get(root);
    if (list) {
      list.push(frag);
    } else {
      byRoot.set(root, [frag]);
    }
  }

  let clustersBeforeFilter = 0;
  const clusters: CloneCluster[] = [];
  for (const [root, rawFrags] of byRoot) {
    if (rawFrags.length < 2) {
      continue;
    }
    clustersBeforeFilter++;

    // Drop test/fixture/generated fragments individually (not all-or-nothing): a single non-test
    // fragment must not drag an otherwise pure-boilerplate cluster into the report.
    const frags = config.excludeTestAndGenerated
      ? rawFrags.filter((f) => !isTestOrGeneratedPath(f.file))
      : rawFrags;
    if (frags.length < 2) {
      continue;
    }

    const maxLines = frags.reduce((m, f) => Math.max(m, f.lines), 0);
    if (maxLines < config.minLines) {
      continue;
    }

    frags.sort((x, y) => x.file.localeCompare(y.file) || x.startLine - y.startLine);
    const fileCount = new Set(frags.map((f) => f.file)).size;
    clusters.push({
      id: clusterId(frags),
      fragments: frags,
      fileCount,
      maxLines,
      sharedFingerprints: pairStrengthByRoot.get(root) ?? 0,
    });
  }

  clusters.sort(
    (a, b) =>
      b.fileCount - a.fileCount ||
      b.maxLines - a.maxLines ||
      b.sharedFingerprints - a.sharedFingerprints ||
      b.fragments.length - a.fragments.length ||
      a.id.localeCompare(b.id),
  );

  return { clusters, clustersBeforeFilter };
}

function buildReport(
  filesScanned: number,
  fingerprinted: FileFingerprints[],
  config: CloneDetectionConfig,
): CloneCandidateReport {
  const { clusters, clustersBeforeFilter } = clusterFingerprints(fingerprinted, config);
  const limited = clusters.slice(0, config.maxClusters);
  return {
    clusters: limited,
    stats: {
      filesScanned,
      filesParsed: fingerprinted.length,
      clustersBeforeFilter,
      clustersAfterFilter: limited.length,
    },
    config,
  };
}

/**
 * Generate token-level duplicate-code candidate clusters across the workspace.
 * Reads every workspace script (bounded by the heuristic-AST byte/file caps).
 *
 * @param overrides  Partial config; unset fields fall back to {@link DEFAULT_CLONE_CONFIG}.
 */
export async function detectCloneCandidates(
  overrides?: Partial<CloneDetectionConfig>,
): Promise<CloneCandidateReport> {
  const policy = getWorkspaceFsPolicy();
  const config: CloneDetectionConfig = { ...DEFAULT_CLONE_CONFIG, ...overrides };
  const files = await listWorkspaceScriptRelPaths();
  const fingerprinted = await fingerprintWorkspace(policy, files, config);
  return buildReport(files.length, fingerprinted, config);
}

/**
 * Same detector over in-memory sources (IO-free) — for tests and callers that already hold content.
 *
 * @param sources  `{ file, code }` pairs; `file` should be a posix-style path (drives lang + path filters).
 * @param overrides  Partial config; unset fields fall back to {@link DEFAULT_CLONE_CONFIG}.
 */
export function detectCloneCandidatesFromSources(
  sources: Array<{ file: string; code: string }>,
  overrides?: Partial<CloneDetectionConfig>,
): CloneCandidateReport {
  const config: CloneDetectionConfig = { ...DEFAULT_CLONE_CONFIG, ...overrides };
  const fingerprinted = fingerprintSources(sources, config);
  return buildReport(sources.length, fingerprinted, config);
}
