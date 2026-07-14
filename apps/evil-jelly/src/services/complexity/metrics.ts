/**
 * Deterministic per-function complexity metrics from an ast-grep parse tree.
 *
 * All metrics are computed over a function node's full subtree (nested callbacks included — a 300-line
 * function with inline closures genuinely is that complex). Naming and structure mirror the clone
 * detector's token walk so both Phase-1 detectors stay consistent.
 */

import type { SgNode } from "@ast-grep/napi";
import type { ComplexityMetrics } from "./types";

/** Function-like node kinds with an executable body. Signatures/overloads (no body) are excluded. */
export const FUNCTION_KINDS = new Set<string>([
  "function_declaration",
  "function_expression",
  "arrow_function",
  "generator_function_declaration",
  "method_definition",
]);

/** Control-flow nodes that introduce a nesting level. */
const DEPTH_KINDS = new Set<string>([
  "if_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
  "switch_statement",
  "try_statement",
  "catch_clause",
]);

/** Decision-point node kinds counted toward the cyclomatic proxy. */
const BRANCH_KINDS = new Set<string>([
  "if_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
  "switch_case",
  "catch_clause",
  "ternary_expression",
]);

/** Short-circuit / nullish operators that each add a decision point inside a binary_expression. */
const LOGICAL_OPS = new Set<string>(["&&", "||", "??"]);

/** Whether a node has an executable body (excludes bare TS signatures/overloads). */
export function hasFunctionBody(node: SgNode): boolean {
  return node.field("body") != null;
}

/** 1-based inclusive line span of a node. */
export function lineSpanOf(node: SgNode): { startLine: number; endLine: number; lines: number } {
  const r = node.range();
  const startLine = r.start.line + 1;
  const endLine = r.end.line + 1;
  return { startLine, endLine, lines: endLine - startLine + 1 };
}

/** Max control-flow nesting depth within (and below) a function node's body. */
function maxNestingDepth(fnNode: SgNode): number {
  let max = 0;
  const walk = (node: SgNode, depth: number): void => {
    const here = DEPTH_KINDS.has(node.kind() as string) ? depth + 1 : depth;
    if (here > max) {
      max = here;
    }
    for (const child of node.children()) {
      walk(child, here);
    }
  };
  // Start from the function's children so the function itself does not count as a level.
  for (const child of fnNode.children()) {
    walk(child, 0);
  }
  return max;
}

/** Cyclomatic-complexity proxy: 1 + decision points in the subtree. */
function branchCount(fnNode: SgNode): number {
  let branches = 1;
  const walk = (node: SgNode): void => {
    const kind = node.kind() as string;
    if (BRANCH_KINDS.has(kind)) {
      branches++;
    } else if (kind === "binary_expression") {
      const op = node.field("operator")?.text();
      if (op && LOGICAL_OPS.has(op)) {
        branches++;
      }
    }
    for (const child of node.children()) {
      walk(child);
    }
  };
  walk(fnNode);
  return branches;
}

/** Declared parameter count, handling both `(a, b)` and the unparenthesized `x => …` arrow form. */
function paramCount(fnNode: SgNode): number {
  const single = fnNode.field("parameter");
  if (single) {
    return 1;
  }
  const params = fnNode.field("parameters");
  if (!params) {
    return 0;
  }
  return params.children().filter((child) => {
    const kind = child.kind() as string;
    return kind !== "(" && kind !== ")" && kind !== "," && kind !== "comment";
  }).length;
}

/** Compute all complexity metrics for one function-like node. */
export function metricsOf(fnNode: SgNode): ComplexityMetrics {
  const { lines } = lineSpanOf(fnNode);
  return {
    lines,
    maxDepth: maxNestingDepth(fnNode),
    branches: branchCount(fnNode),
    params: paramCount(fnNode),
  };
}
