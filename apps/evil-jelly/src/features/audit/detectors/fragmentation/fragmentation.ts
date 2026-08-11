/**
 * Fragmentation (over-decomposition) candidate generator — the third Phase-1 detector for the audit
 * topology (INV-0008), and the first one built on the file-level import graph.
 *
 * Signal ① (MVP, "single-consumer micro-cluster"): a file that is small (≤ maxFileLines), is imported by
 * exactly one other file via a relative edge, and whose importer is a sibling/parent in the same feature
 * is a *satellite* private to that consumer. Union satellites with their unique consumer (connected
 * components) → a host plus its private satellites = a "fact unit" that may want to merge back together.
 *
 * Deterministic and zero-LLM: emits ranked *candidate* clusters with full membership. Whether to merge
 * (and how far) is the per-seed evaluator's job. Directory-level dispersion and git co-change are deferred
 * (post-launch; co-change is blocked by the launch git wipe — see INV-0008 §2.3).
 */

import path from "node:path";
import { getWorkspaceFsPolicy } from "../../../../shared/fs-policy/workspace-fs-policy";
import { listWorkspaceScriptRelPaths } from "../../../../shared/fs-policy/workspace-paths";
import { fnv1a32Hex } from "../../../../shared/lib/hash";
import { MAX_HEURISTIC_AST_BYTES } from "../../../../shared/lib/heuristicAstLimits";
import { isTestOrGeneratedPath } from "../../../../shared/lib/path";
import { buildImportGraph, type FragmentationSource, type ImportGraph } from "./importGraph";
import {
  DEFAULT_FRAGMENTATION_CONFIG,
  type FragmentationCandidateReport,
  type FragmentationCluster,
  type FragmentationDetectionConfig,
  type FragmentationMember,
} from "./types";

/** Source line count of a file (a trailing newline does not add a phantom line). */
function countLines(code: string): number {
  if (code.length === 0) {
    return 0;
  }
  const parts = code.split(/\r?\n/);
  if (parts.length > 1 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts.length;
}

/** Barrel/re-export modules (`index.*`) are intentional aggregation points, never satellites. */
function isBarrel(file: string): boolean {
  return /^index\.[cm]?[jt]sx?$/.test(path.posix.basename(file));
}

/**
 * Whether `consumer` is a sibling or parent of `micro` in the same feature: same directory (sibling), or
 * the consumer's directory is an ancestor of the micro's directory (parent). A deeper consumer importing
 * upward is *not* near — the host should be the file the satellite was split out of, not a child of it.
 */
function isNearConsumer(consumer: string, micro: string): boolean {
  const consumerDir = path.posix.dirname(consumer);
  const microDir = path.posix.dirname(micro);
  return consumerDir === microDir || microDir.startsWith(`${consumerDir}/`);
}

/** Minimal union-find over file paths for grouping satellites with their (transitive) consumers. */
class UnionFind {
  private readonly parent = new Map<string, string>();

  find(x: string): string {
    let root = this.parent.get(x) ?? x;
    if (root === x) {
      this.parent.set(x, x);
      return x;
    }
    root = this.find(root);
    this.parent.set(x, root);
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) {
      this.parent.set(ra, rb);
    }
  }
}

function clusterId(members: string[]): string {
  const key = members.join("|");
  return `fragmentation:${fnv1a32Hex(key)}`;
}

interface MicroEdge {
  micro: string;
  consumer: string;
}

/** Collect the satellite→consumer edges: small, single-consumer, near-importer, non-barrel files. */
function collectMicroEdges(
  files: string[],
  graph: ImportGraph,
  linesOf: Map<string, number>,
  config: FragmentationDetectionConfig,
): MicroEdge[] {
  const edges: MicroEdge[] = [];
  for (const file of files) {
    if (isBarrel(file)) {
      continue;
    }
    if ((linesOf.get(file) ?? Number.POSITIVE_INFINITY) > config.maxFileLines) {
      continue;
    }
    const importers = graph.importersOf.get(file);
    if (!importers || importers.size !== 1) {
      continue;
    }
    const consumer = [...importers][0];
    if (!isNearConsumer(consumer, file)) {
      continue;
    }
    edges.push({ micro: file, consumer });
  }
  return edges;
}

/** Pick the host of a component: a member that is some satellite's consumer (a value, not a satellite). */
function pickHost(members: string[], satellites: Set<string>, graph: ImportGraph): string {
  const hosts = members.filter((m) => !satellites.has(m));
  const pool = hosts.length > 0 ? hosts : members;
  return [...pool].sort(
    (a, b) =>
      (graph.importersOf.get(b)?.size ?? 0) - (graph.importersOf.get(a)?.size ?? 0) ||
      a.localeCompare(b),
  )[0];
}

function buildCluster(
  members: string[],
  satellites: Set<string>,
  host: string,
  linesOf: Map<string, number>,
  graph: ImportGraph,
): FragmentationCluster {
  const sorted = [...members].sort((a, b) => a.localeCompare(b));
  const memberViews: FragmentationMember[] = sorted.map((file) => ({
    file,
    lines: linesOf.get(file) ?? 0,
    importerCount: graph.importersOf.get(file)?.size ?? 0,
    isHost: file === host,
  }));
  const totalLines = memberViews.reduce((sum, m) => sum + m.lines, 0);
  const satelliteCount = memberViews.filter((m) => satellites.has(m.file)).length;
  return {
    id: clusterId(sorted),
    host,
    members: memberViews,
    fileCount: memberViews.length,
    satelliteCount,
    totalLines,
    // Favor clusters with more satellites first, then more code at stake.
    score: satelliteCount * 1000 + totalLines,
  };
}

/** Union micro edges into connected components, then build a cluster per component meeting the floor. */
function clusterMicroEdges(
  edges: MicroEdge[],
  graph: ImportGraph,
  linesOf: Map<string, number>,
  config: FragmentationDetectionConfig,
): FragmentationCluster[] {
  const uf = new UnionFind();
  const satellites = new Set<string>();
  for (const { micro, consumer } of edges) {
    uf.union(micro, consumer);
    satellites.add(micro);
  }

  const components = new Map<string, Set<string>>();
  for (const { micro, consumer } of edges) {
    for (const node of [micro, consumer]) {
      const root = uf.find(node);
      let set = components.get(root);
      if (!set) {
        set = new Set<string>();
        components.set(root, set);
      }
      set.add(node);
    }
  }

  const clusters: FragmentationCluster[] = [];
  for (const set of components.values()) {
    const members = [...set];
    if (members.length < config.minClusterFiles) {
      continue;
    }
    const host = pickHost(members, satellites, graph);
    clusters.push(buildCluster(members, satellites, host, linesOf, graph));
  }
  return clusters;
}

function buildReport(
  filesScanned: number,
  sources: FragmentationSource[],
  config: FragmentationDetectionConfig,
): FragmentationCandidateReport {
  const linesOf = new Map(sources.map((s) => [s.file, countLines(s.code)]));
  const graph = buildImportGraph(sources);
  const files = sources.map((s) => s.file);
  const edges = collectMicroEdges(files, graph, linesOf, config);
  const clusters = clusterMicroEdges(edges, graph, linesOf, config);

  clusters.sort(
    (a, b) =>
      b.score - a.score || b.satelliteCount - a.satelliteCount || a.host.localeCompare(b.host),
  );

  return {
    clusters: clusters.slice(0, config.maxClusters),
    stats: {
      filesScanned,
      filesParsed: graph.filesParsed,
      edgesResolved: graph.edgeCount,
      clustersFound: clusters.length,
    },
    config,
  };
}

/**
 * Generate fragmentation candidates across the workspace. Reads every workspace script (bounded by the
 * heuristic-AST byte/file caps) and clusters single-consumer micro files with their host.
 *
 * @param overrides  Partial config; unset fields fall back to {@link DEFAULT_FRAGMENTATION_CONFIG}.
 */
export async function detectFragmentationCandidates(
  overrides?: Partial<FragmentationDetectionConfig>,
): Promise<FragmentationCandidateReport> {
  const policy = getWorkspaceFsPolicy();
  const config: FragmentationDetectionConfig = { ...DEFAULT_FRAGMENTATION_CONFIG, ...overrides };
  const files = await listWorkspaceScriptRelPaths();
  const sources: FragmentationSource[] = [];

  for (const file of files) {
    if (config.excludeTestAndGenerated && isTestOrGeneratedPath(file)) {
      continue;
    }
    try {
      const stat = await policy.stat(file);
      if (stat.size > MAX_HEURISTIC_AST_BYTES) {
        continue;
      }
      sources.push({ file, code: await policy.readAstFile(file) });
    } catch {}
  }

  return buildReport(files.length, sources, config);
}

/**
 * Same detector over in-memory sources (IO-free) — for tests and callers that already hold content.
 *
 * @param sources  `{ file, code }` pairs; `file` should be a posix-style path (drives lang + path filters).
 * @param overrides  Partial config; unset fields fall back to {@link DEFAULT_FRAGMENTATION_CONFIG}.
 */
export function detectFragmentationCandidatesFromSources(
  sources: FragmentationSource[],
  overrides?: Partial<FragmentationDetectionConfig>,
): FragmentationCandidateReport {
  const config: FragmentationDetectionConfig = { ...DEFAULT_FRAGMENTATION_CONFIG, ...overrides };
  const kept = config.excludeTestAndGenerated
    ? sources.filter((s) => !isTestOrGeneratedPath(s.file))
    : sources;
  return buildReport(sources.length, kept, config);
}
