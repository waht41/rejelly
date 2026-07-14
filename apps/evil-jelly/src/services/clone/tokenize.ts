/**
 * Normalized token stream from an ast-grep parse tree.
 *
 * Normalization is what turns Type-2 clones (same shape, renamed identifiers / changed literals)
 * into identical token sequences: every identifier collapses to `$ID`, every literal to `$LIT`,
 * while keywords and punctuation are kept verbatim. Comments are dropped. Strings, templates,
 * numbers and regexes are treated as atomic so their inner structure does not fragment the stream.
 */

import type { SgNode } from "@ast-grep/napi";
import type { NormalizedToken } from "./types";

const ID_PLACEHOLDER = "$ID";
const LIT_PLACEHOLDER = "$LIT";

/** Identifier-like node kinds collapsed to a single `$ID` token. */
const IDENTIFIER_KINDS = new Set<string>([
  "identifier",
  "property_identifier",
  "shorthand_property_identifier",
  "shorthand_property_identifier_pattern",
  "private_property_identifier",
  "type_identifier",
]);

/**
 * Literal-like node kinds collapsed to a single `$LIT` token. These are treated as atomic: the
 * walk does not descend into them, so e.g. a string's quotes/fragments don't become tokens.
 */
const LITERAL_KINDS = new Set<string>(["string", "template_string", "number", "regex"]);

/**
 * Node kinds skipped entirely (and not descended into). Each is dropped because its normalized shape
 * repeats across nearly every file and bridges unrelated code into giant false clusters, while never
 * being a logic-refactor target:
 *  - `import_statement`: `import { $ID } from $LIT`. Re-exports (`export … from`) handled below.
 *  - type-level declarations (`interface` / `type` / `enum`): duplicated type *shape* is not logic
 *    duplication — identical types would already share a definition, and these are a prime union-find
 *    bridge between unrelated files. (Value-level schema/config boilerplate like
 *    `const X = z.object({…})` is a finer AST-level call left to the audit seed pre-filter.)
 */
const SKIP_KINDS = new Set<string>([
  "comment",
  "import_statement",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
]);

/** Whether an export_statement is a bare re-export (`export { x } from "y"` / `export * from "y"`). */
function isReexport(node: SgNode): boolean {
  for (const child of node.children()) {
    if (child.kind() === "string") {
      return true;
    }
  }
  return false;
}

/**
 * Walk a parsed file in source order and emit its normalized token stream.
 *
 * @param root  Root SgNode from a workspace parse.
 */
export function tokenizeNormalized(root: SgNode): NormalizedToken[] {
  const out: NormalizedToken[] = [];

  const visit = (node: SgNode): void => {
    const kind = node.kind() as string;

    if (SKIP_KINDS.has(kind)) {
      return;
    }
    if (kind === "export_statement" && isReexport(node)) {
      return;
    }
    if (IDENTIFIER_KINDS.has(kind)) {
      out.push({ norm: ID_PLACEHOLDER, line: node.range().start.line + 1 });
      return;
    }
    if (LITERAL_KINDS.has(kind)) {
      out.push({ norm: LIT_PLACEHOLDER, line: node.range().start.line + 1 });
      return;
    }

    if (node.isLeaf()) {
      const text = node.text();
      if (text.length > 0) {
        out.push({ norm: text, line: node.range().start.line + 1 });
      }
      return;
    }

    for (const child of node.children()) {
      visit(child);
    }
  };

  visit(root);
  return out;
}
