/**
 * Function-complexity candidate generator (a second Phase-1 detector for the audit topology, INV-0008).
 *
 * Deterministic, zero-LLM: parse each workspace script, walk for function-like nodes, compute cheap
 * metrics (size / nesting / branching / arity) and emit the ones that cross a threshold. Only the
 * outermost crossing function in any nesting chain is emitted, so a giant function and the giant
 * inline closure it contains are reported once, not twice.
 *
 * Output is *candidates* with metrics, not verdicts: whether (and how) to decompose is the agent's
 * job (Phase 2). Unlike clone, each candidate is a single location.
 */

import type { SgNode } from "@ast-grep/napi";
import { MAX_HEURISTIC_AST_BYTES } from "../../../../domains/workspace/source/heuristicAstLimits";
import { listWorkspaceScriptRelPaths } from "../../../../domains/workspace/source/workspacePaths";
import { fnv1a32Hex } from "../../../../shared/foundation/fnv1a";
import { getWorkspaceFsPolicy } from "../../../../shared/fs-policy/workspace-fs-policy";
import { isTestOrGeneratedPath } from "../../sourcePath";
import { tryParseRoot } from "../astParse";
import { FUNCTION_KINDS, hasFunctionBody, lineSpanOf, metricsOf } from "./metrics";
import {
  type ComplexityCandidateReport,
  type ComplexityDetectionConfig,
  type ComplexityFinding,
  type ComplexityMetrics,
  DEFAULT_COMPLEXITY_CONFIG,
} from "./types";

/** Best-effort function name; falls back to the binding it is assigned to, else `(anonymous)`. */
function functionName(node: SgNode): string {
  const direct = node.field("name")?.text();
  if (direct) {
    return direct;
  }
  const parent = node.parent();
  if (parent) {
    switch (parent.kind() as string) {
      case "variable_declarator":
        return parent.field("name")?.text() ?? "(anonymous)";
      case "pair":
        return parent.field("key")?.text() ?? "(anonymous)";
      case "public_field_definition":
        return parent.field("name")?.text() ?? "(anonymous)";
      case "assignment_expression":
        return parent.field("left")?.text() ?? "(anonymous)";
    }
  }
  return "(anonymous)";
}

/** Whether a function's metrics cross any configured threshold (after the minLines floor). */
function crosses(metrics: ComplexityMetrics, config: ComplexityDetectionConfig): boolean {
  if (metrics.lines < config.minLines) {
    return false;
  }
  return (
    metrics.lines >= config.maxLines ||
    metrics.maxDepth >= config.maxDepth ||
    metrics.branches >= config.maxBranches ||
    metrics.params >= config.maxParams
  );
}

function reasonsFor(metrics: ComplexityMetrics, config: ComplexityDetectionConfig): string[] {
  const reasons: string[] = [];
  if (metrics.lines >= config.maxLines) {
    reasons.push(`${metrics.lines} lines ≥ ${config.maxLines}`);
  }
  if (metrics.maxDepth >= config.maxDepth) {
    reasons.push(`nesting depth ${metrics.maxDepth} ≥ ${config.maxDepth}`);
  }
  if (metrics.branches >= config.maxBranches) {
    reasons.push(`cyclomatic ${metrics.branches} ≥ ${config.maxBranches}`);
  }
  if (metrics.params >= config.maxParams) {
    reasons.push(`${metrics.params} params ≥ ${config.maxParams}`);
  }
  return reasons;
}

/** Ranking score: line count plus weighted nesting/branching/arity overflow. Higher = worse. */
function scoreOf(metrics: ComplexityMetrics): number {
  return metrics.lines + metrics.maxDepth * 15 + metrics.branches * 4 + metrics.params * 4;
}

function findingId(file: string, name: string, startLine: number): string {
  const key = `${file}#${name}@${startLine}`;
  return fnv1a32Hex(key);
}

interface AnalysisResult {
  findings: ComplexityFinding[];
  functionsAnalyzed: number;
}

/** Walk one file's tree, emitting the outermost function in each nesting chain that crosses. */
function analyzeFile(
  root: SgNode,
  file: string,
  config: ComplexityDetectionConfig,
): AnalysisResult {
  const findings: ComplexityFinding[] = [];
  let functionsAnalyzed = 0;

  const walk = (node: SgNode, suppressed: boolean): void => {
    let nextSuppressed = suppressed;
    if (FUNCTION_KINDS.has(node.kind() as string) && hasFunctionBody(node)) {
      functionsAnalyzed++;
      const metrics = metricsOf(node);
      if (crosses(metrics, config)) {
        nextSuppressed = true; // descendants belong to a reported function either way
        if (!suppressed) {
          const { startLine, endLine } = lineSpanOf(node);
          const name = functionName(node);
          findings.push({
            id: `complexity:${findingId(file, name, startLine)}`,
            file,
            name,
            startLine,
            endLine,
            metrics,
            reasons: reasonsFor(metrics, config),
            score: scoreOf(metrics),
          });
        }
      }
    }
    for (const child of node.children()) {
      walk(child, nextSuppressed);
    }
  };

  walk(root, false);
  return { findings, functionsAnalyzed };
}

/** Parse + analyze one source. Null on parse failure. */
function analyzeOne(
  file: string,
  code: string,
  config: ComplexityDetectionConfig,
): AnalysisResult | null {
  const root = tryParseRoot(file, code);
  if (!root) {
    return null;
  }
  return analyzeFile(root, file, config);
}

function buildReport(
  filesScanned: number,
  filesParsed: number,
  raw: ComplexityFinding[],
  functionsAnalyzed: number,
  config: ComplexityDetectionConfig,
): ComplexityCandidateReport {
  raw.sort(
    (a, b) =>
      b.score - a.score ||
      b.metrics.lines - a.metrics.lines ||
      a.file.localeCompare(b.file) ||
      a.startLine - b.startLine,
  );
  return {
    findings: raw.slice(0, config.maxFindings),
    stats: {
      filesScanned,
      filesParsed,
      functionsAnalyzed,
      findingsBeforeCap: raw.length,
    },
    config,
  };
}

/**
 * Generate function-complexity candidates across the workspace.
 * Reads every workspace script (bounded by the heuristic-AST byte/file caps).
 *
 * @param overrides  Partial config; unset fields fall back to {@link DEFAULT_COMPLEXITY_CONFIG}.
 */
export async function detectComplexityCandidates(
  overrides?: Partial<ComplexityDetectionConfig>,
): Promise<ComplexityCandidateReport> {
  const policy = getWorkspaceFsPolicy();
  const config: ComplexityDetectionConfig = { ...DEFAULT_COMPLEXITY_CONFIG, ...overrides };
  const files = await listWorkspaceScriptRelPaths();
  const findings: ComplexityFinding[] = [];
  let filesParsed = 0;
  let functionsAnalyzed = 0;

  for (const file of files) {
    if (config.excludeTestAndGenerated && isTestOrGeneratedPath(file)) {
      continue;
    }
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
    const result = analyzeOne(file, code, config);
    if (result) {
      filesParsed++;
      functionsAnalyzed += result.functionsAnalyzed;
      findings.push(...result.findings);
    }
  }

  return buildReport(files.length, filesParsed, findings, functionsAnalyzed, config);
}

/**
 * Same detector over in-memory sources (IO-free) — for tests and callers that already hold content.
 *
 * @param sources  `{ file, code }` pairs; `file` should be a posix-style path (drives lang + path filters).
 * @param overrides  Partial config; unset fields fall back to {@link DEFAULT_COMPLEXITY_CONFIG}.
 */
export function detectComplexityCandidatesFromSources(
  sources: Array<{ file: string; code: string }>,
  overrides?: Partial<ComplexityDetectionConfig>,
): ComplexityCandidateReport {
  const config: ComplexityDetectionConfig = { ...DEFAULT_COMPLEXITY_CONFIG, ...overrides };
  const findings: ComplexityFinding[] = [];
  let filesParsed = 0;
  let functionsAnalyzed = 0;

  for (const { file, code } of sources) {
    if (config.excludeTestAndGenerated && isTestOrGeneratedPath(file)) {
      continue;
    }
    const result = analyzeOne(file, code, config);
    if (result) {
      filesParsed++;
      functionsAnalyzed += result.functionsAnalyzed;
      findings.push(...result.findings);
    }
  }

  return buildReport(sources.length, filesParsed, findings, functionsAnalyzed, config);
}
