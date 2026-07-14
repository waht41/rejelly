/**
 * Callable dependency tree for heuristic AST tools.
 */

import type { ToolDefinition } from "@rejelly/core";
import { z } from "zod";
import { findCallableDeclarationForSymbol, getCallableEnvelope } from "../../services/ast/queries";
import { MAX_FUNCTION_DEPENDENCY_DEPTH } from "../../shared/lib/heuristicAstLimits";
import {
  type DependencyJsonRow,
  expandDependencyRow,
  extractCalleeNamesFromEnvelope,
  getParsedAst,
  MAX_DEPENDENCY_ROWS_TOTAL,
  truncateJson,
} from "./shared";

export const astGetFunctionDependenciesParameters = z.object({
  symbolName: z.string().min(1).describe("Target function or method name."),
  filePath: z.string().min(1).describe("Workspace-relative path containing that callable."),
  depth: z
    .number()
    .int()
    .min(1)
    .max(MAX_FUNCTION_DEPENDENCY_DEPTH)
    .optional()
    .default(1)
    .describe(
      "How many dependency levels to expand (1 = direct callees only). Each callee lists signature + JSDoc, optionally nested.",
    ),
  caseInsensitive: z
    .boolean()
    .optional()
    .default(false)
    .describe("When matching symbolName to declarations in filePath."),
});

type AstGetFunctionDependenciesArgs = z.infer<typeof astGetFunctionDependenciesParameters>;

export async function astGetFunctionDependenciesService(
  args: AstGetFunctionDependenciesArgs,
): Promise<string> {
  const { symbolName, filePath, depth, caseInsensitive } = args;
  const parsed = await getParsedAst(filePath, { parseErrorStyle: "minimal" });
  if (!parsed.ok) {
    return parsed.error;
  }
  const { rel, text, root, lang } = parsed;
  const decl = findCallableDeclarationForSymbol(root, symbolName, caseInsensitive);
  if (!decl) {
    return `No callable declaration named "${symbolName}" in ${rel.replace(/\\/g, "/")}.`;
  }
  const envelope = getCallableEnvelope(decl);
  if (!envelope) {
    return `Symbol "${symbolName}" has no callable body (expected function, method, or const arrow/function).`;
  }
  const calleeNames = extractCalleeNamesFromEnvelope(envelope, lang);
  const visited = new Set<string>([symbolName]);
  const budget = { left: MAX_DEPENDENCY_ROWS_TOTAL };
  const dependencies: DependencyJsonRow[] = [];
  for (const callee of calleeNames) {
    if (budget.left <= 0) {
      break;
    }
    const row = await expandDependencyRow(callee, rel, text, root, depth, visited, budget);
    if (row) {
      dependencies.push(row);
    }
  }
  const relOut = rel.replace(/\\/g, "/");
  return truncateJson({
    target: { symbolName, file: relOut },
    depth,
    dependencies,
    truncatedRows: budget.left <= 0,
    disclaimer:
      "Heuristic binding (no type checker). Member calls report the property name; aliases and re-exports may resolve incorrectly.",
  });
}

export const AstGetFunctionDependenciesTool: ToolDefinition<
  typeof astGetFunctionDependenciesParameters
> = {
  name: "ast_get_function_dependencies",
  description:
    "Static scan of one callable: lists external functions/classes it invokes (not locals). " +
    "For each callee, resolves its declaration (same file, import path, then workspace heuristic) and returns signature head plus adjacent JSDoc only — no bodies. " +
    "Use depth>1 to recurse into those callees’ own dependencies.",
  parameters: astGetFunctionDependenciesParameters,
  handler: async (args) => astGetFunctionDependenciesService(args),
};
