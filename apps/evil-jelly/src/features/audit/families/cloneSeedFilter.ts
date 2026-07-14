/**
 * Deterministic seed pre-filter (INV-0008 §2.3): drop duplicate-code candidates whose fragments are
 * pure *declarations* — type/interface/enum, plain object/array literals, or schema-builder chains.
 * Duplicated declaration shape is never a logic-refactor target (two identical type shapes would
 * already share a type; repeated zod/config boilerplate is framework contract, not drift). Removing
 * them up front saves an LLM call each and cuts report noise.
 *
 * AST-based, not text matching: only the parse tree can tell `const x = {…}` (data) from
 * `const f = () => { if … }` (logic). Conservative whitelist per Codex review — anything carrying
 * executable code in the fragment range (callback, function body, control flow, return/throw/await,
 * assignment) forces KEEP, so the false-drop rate is ~0 at the cost of leaving some idiom noise for
 * the LLM (which is the irreducible recall/precision part anyway).
 */

import type { SgNode } from "@ast-grep/napi";
import { tryParseWorkspaceRel } from "../../../services/ast/heuristicAstCore";
import type { CloneCluster, CloneFragment } from "../../../services/clone";

/** Any of these intersecting a fragment range carries executable logic → force KEEP. */
const CODE_CARRIER_KINDS = [
  "arrow_function",
  "function_expression",
  "function_declaration",
  "generator_function_declaration",
  "if_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
  "switch_statement",
  "try_statement",
  "return_statement",
  "throw_statement",
  "await_expression",
  "assignment_expression",
  "augmented_assignment_expression",
  "update_expression",
] as const;

/** Pure type-level declarations: safe to treat as non-behavioral. */
const TYPE_DECL_KINDS = ["interface_declaration", "type_alias_declaration", "enum_declaration"];

const VAR_DECL_KINDS = ["lexical_declaration", "variable_declaration"];

type LineRange = [start: number, end: number];

type FragmentClass = "declaration" | "code";

export interface FileBehavior {
  carriers: LineRange[];
  exprStatements: LineRange[];
  typeDecls: LineRange[];
  /** Variable declarations with whether every declarator's initializer is pure data/schema. */
  varDecls: Array<{ range: LineRange; pureData: boolean }>;
}

/** 1-based inclusive line range of a node (ast-grep lines are 0-based). */
function lineRangeOf(node: SgNode): LineRange {
  const r = node.range();
  return [r.start.line + 1, r.end.line + 1];
}

function intersects(range: LineRange, startLine: number, endLine: number): boolean {
  return range[0] <= endLine && range[1] >= startLine;
}

function findAllRanges(root: SgNode, kinds: readonly string[]): LineRange[] {
  return root
    .findAll({ rule: { any: kinds.map((kind) => ({ kind })) } })
    .map((n) => lineRangeOf(n));
}

/**
 * Whether an initializer is "pure data": an object/array literal, or a builder call chain
 * (member-expression callee, e.g. `z.object().describe()`) or a call taking an object/array literal
 * argument (e.g. `z.object({…})`). Callbacks/functions are already excluded by the carrier pass.
 */
function isPureDataInitializer(value: SgNode): boolean {
  const kind = value.kind();
  if (kind === "object" || kind === "array") {
    return true;
  }
  if (kind === "call_expression") {
    const callee = value.field("function");
    if (callee?.kind() === "member_expression") {
      return true;
    }
    const args = value.field("arguments");
    if (
      args &&
      args.findAll({ rule: { any: [{ kind: "object" }, { kind: "array" }] } }).length > 0
    ) {
      return true;
    }
    return false;
  }
  return false;
}

function varDeclIsPureData(decl: SgNode): boolean {
  const declarators = decl.findAll({ rule: { kind: "variable_declarator" } });
  if (declarators.length === 0) {
    return false;
  }
  for (const d of declarators) {
    const value = d.field("value");
    if (!value || !isPureDataInitializer(value)) {
      return false;
    }
  }
  return true;
}

export function analyzeFileBehavior(root: SgNode): FileBehavior {
  return {
    carriers: findAllRanges(root, CODE_CARRIER_KINDS),
    exprStatements: findAllRanges(root, ["expression_statement"]),
    typeDecls: findAllRanges(root, TYPE_DECL_KINDS),
    varDecls: root
      .findAll({ rule: { any: VAR_DECL_KINDS.map((kind) => ({ kind })) } })
      .map((decl) => ({ range: lineRangeOf(decl), pureData: varDeclIsPureData(decl) })),
  };
}

/**
 * Classify one fragment. "declaration" only when the range is purely type decls / pure-data
 * variable decls with no executable carrier; everything else (including expression idioms and
 * impure initializers like ternaries) stays "code".
 */
export function classifyFragment(fb: FileBehavior, fragment: CloneFragment): FragmentClass {
  const { startLine: s, endLine: e } = fragment;

  // Any executable carrier (function/callback/control-flow/return/...) → keep.
  if (fb.carriers.some((r) => intersects(r, s, e))) {
    return "code";
  }
  // Bare statements (side-effecting call sequences) are not whitelisted → keep.
  if (fb.exprStatements.some((r) => intersects(r, s, e))) {
    return "code";
  }
  const intersectingVars = fb.varDecls.filter((v) => intersects(v.range, s, e));
  // A variable decl with a non-pure initializer (ternary, binary, identifier, …) → keep.
  if (intersectingVars.some((v) => !v.pureData)) {
    return "code";
  }
  const hasTypeDecl = fb.typeDecls.some((r) => intersects(r, s, e));
  const hasPureVar = intersectingVars.length > 0; // all pure here
  // Require at least one declaration so empty/comment-only ranges default to keep.
  return hasTypeDecl || hasPureVar ? "declaration" : "code";
}

/** Behavioral fragments of a cluster (parse failure → treat as behavioral, conservatively). */
async function behavioralFragments(
  cluster: CloneCluster,
  cache: Map<string, FileBehavior | null>,
): Promise<CloneFragment[]> {
  const out: CloneFragment[] = [];
  for (const fragment of cluster.fragments) {
    let fb = cache.get(fragment.file);
    if (fb === undefined) {
      const parsed = await tryParseWorkspaceRel(fragment.file);
      fb = parsed ? analyzeFileBehavior(parsed.root) : null;
      cache.set(fragment.file, fb);
    }
    if (!fb || classifyFragment(fb, fragment) === "code") {
      out.push(fragment);
    }
  }
  return out;
}

/**
 * Filter seeds **per fragment**, not all-or-nothing: a cluster keeps only its behavioral fragments,
 * and is dropped when fewer than two remain. This matters because the detector over-merges — a few
 * stray code fragments must not keep a cluster of duplicated type/schema/config declarations alive,
 * and conversely a real finding is cleaned of its coincidental declaration members. Each referenced
 * file is parsed at most once.
 */
export async function filterBehavioralSeeds(
  clusters: CloneCluster[],
): Promise<{ kept: CloneCluster[]; dropped: CloneCluster[] }> {
  const cache = new Map<string, FileBehavior | null>();
  const kept: CloneCluster[] = [];
  const dropped: CloneCluster[] = [];
  for (const cluster of clusters) {
    const fragments = await behavioralFragments(cluster, cache);
    if (fragments.length < 2) {
      dropped.push(cluster);
      continue;
    }
    if (fragments.length === cluster.fragments.length) {
      kept.push(cluster);
      continue;
    }
    // Trimmed: rebuild the derived fields the report relies on.
    kept.push({
      ...cluster,
      fragments,
      fileCount: new Set(fragments.map((f) => f.file)).size,
      maxLines: fragments.reduce((m, f) => Math.max(m, f.lines), 0),
    });
  }
  return { kept, dropped };
}
