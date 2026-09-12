import { Lang, type SgNode } from "@ast-grep/napi";
import { MAX_NAMED_DECL_MATCHES } from "../source/heuristicAstLimits";

/**
 * Node kinds that exist only in the TypeScript / TSX tree-sitter grammars. ast-grep
 * validates `rule.kind` against the grammar of the parsed language and throws
 * ("Kind `...` is invalid") when a JavaScript parse is queried with one of these,
 * so every findAll on them must be gated by the source language.
 */
const TS_ONLY_KINDS: ReadonlySet<string> = new Set([
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "required_parameter",
  "optional_parameter",
]);

/** findAll by kind, returning no matches instead of throwing when the kind is absent from the language's grammar. */
function findAllOfKind(node: SgNode, kind: string, lang: Lang): SgNode[] {
  if (lang === Lang.JavaScript && TS_ONLY_KINDS.has(kind)) {
    return [];
  }
  return node.findAll({ rule: { kind } });
}

export type HeuristicSymbolKind =
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "function"
  | "method"
  | "variable";

export type HeuristicSymbolRow = {
  kind: HeuristicSymbolKind;
  name: string;
  /** 1-based line number */
  line: number;
};

/**
 * Outline-style scope: module / export / namespace / class body, but not inside a
 * non-class function, arrow, or object-literal method body (locals and nested decls excluded).
 */
export function isModuleOutlineDeclaration(declNode: SgNode): boolean {
  let cur: SgNode | null | undefined = declNode.parent();
  while (cur) {
    const k = cur.kind();
    if (k === "program") {
      return true;
    }
    if (k === "export_statement") {
      cur = cur.parent();
      continue;
    }
    if (k === "arrow_function" || k === "function_expression") {
      return false;
    }
    if (k === "function_declaration") {
      return false;
    }
    if (k === "method_definition") {
      return false;
    }
    cur = cur.parent();
  }
  return false;
}

export type OutlineDeclaration = {
  kind: HeuristicSymbolKind;
  name: string;
  node: SgNode;
};

/** Outline declarations with their AST nodes (for signature slicing / export checks). */
export function collectOutlineDeclarations(root: SgNode, lang: Lang): OutlineDeclaration[] {
  const rows: OutlineDeclaration[] = [];
  const push = (kind: HeuristicSymbolKind, node: SgNode, name: string) => {
    rows.push({ kind, name, node });
  };

  for (const n of findAllOfKind(root, "class_declaration", lang)) {
    const name = n.field("name")?.text();
    if (name && isModuleOutlineDeclaration(n)) {
      push("class", n, name);
    }
  }
  for (const n of findAllOfKind(root, "interface_declaration", lang)) {
    const name = n.field("name")?.text();
    if (name && isModuleOutlineDeclaration(n)) {
      push("interface", n, name);
    }
  }
  for (const n of findAllOfKind(root, "type_alias_declaration", lang)) {
    const name = n.field("name")?.text();
    if (name && isModuleOutlineDeclaration(n)) {
      push("type", n, name);
    }
  }
  for (const n of findAllOfKind(root, "enum_declaration", lang)) {
    const name = n.field("name")?.text();
    if (name && isModuleOutlineDeclaration(n)) {
      push("enum", n, name);
    }
  }
  for (const n of findAllOfKind(root, "function_declaration", lang)) {
    const name = n.field("name")?.text();
    if (name && isModuleOutlineDeclaration(n)) {
      push("function", n, name);
    }
  }
  for (const n of findAllOfKind(root, "method_definition", lang)) {
    if (n.parent()?.kind() !== "class_body") {
      continue;
    }
    const name = n.field("name")?.text();
    if (name && isModuleOutlineDeclaration(n)) {
      push("method", n, name);
    }
  }
  for (const n of findAllOfKind(root, "variable_declarator", lang)) {
    const nameNode = n.field("name");
    if (nameNode?.kind() !== "identifier") {
      continue;
    }
    if (!isModuleOutlineDeclaration(n)) {
      continue;
    }
    push("variable", n, nameNode.text());
  }

  rows.sort((a, b) => {
    const aStart = a.node.range().start;
    const bStart = b.node.range().start;
    return aStart.line - bStart.line || aStart.column - bStart.column;
  });
  return rows;
}

export function collectDocumentSymbols(root: SgNode, lang: Lang): HeuristicSymbolRow[] {
  return collectOutlineDeclarations(root, lang).map(({ kind, name, node }) => ({
    kind,
    name,
    line: node.range().start.line + 1,
  }));
}

export function filterDeclarationsByName(
  rows: HeuristicSymbolRow[],
  queryName: string,
  caseInsensitive: boolean,
): HeuristicSymbolRow[] {
  const q = caseInsensitive ? queryName.toLowerCase() : queryName;
  return rows.filter((r) => {
    const n = caseInsensitive ? r.name.toLowerCase() : r.name;
    return n === q;
  });
}

function matchDeclarationName(
  symbolName: string,
  candidate: string,
  caseInsensitive: boolean,
): boolean {
  if (caseInsensitive) {
    return candidate.toLowerCase() === symbolName.toLowerCase();
  }
  return candidate === symbolName;
}

/**
 * Declaration nodes that bind this identifier anywhere in the file (including nested scopes).
 * Sorted by start position for symbol-code queries.
 */
export function findNamedDeclarationAstNodes(
  root: SgNode,
  symbolName: string,
  caseInsensitive: boolean,
  lang: Lang,
): SgNode[] {
  const out: SgNode[] = [];
  const tryCapture = (declNode: SgNode, name: string | undefined) => {
    if (!name || !matchDeclarationName(symbolName, name, caseInsensitive)) {
      return;
    }
    out.push(declNode);
  };

  for (const n of findAllOfKind(root, "class_declaration", lang)) {
    tryCapture(n, n.field("name")?.text());
  }
  for (const n of findAllOfKind(root, "interface_declaration", lang)) {
    tryCapture(n, n.field("name")?.text());
  }
  for (const n of findAllOfKind(root, "type_alias_declaration", lang)) {
    tryCapture(n, n.field("name")?.text());
  }
  for (const n of findAllOfKind(root, "enum_declaration", lang)) {
    tryCapture(n, n.field("name")?.text());
  }
  for (const n of findAllOfKind(root, "function_declaration", lang)) {
    tryCapture(n, n.field("name")?.text());
  }
  for (const n of findAllOfKind(root, "method_definition", lang)) {
    tryCapture(n, n.field("name")?.text());
  }
  for (const n of findAllOfKind(root, "variable_declarator", lang)) {
    const id = n.field("name");
    if (id?.kind() !== "identifier") {
      continue;
    }
    tryCapture(n, id.text());
  }

  out.sort((a, b) => {
    const ra = a.range().start;
    const rb = b.range().start;
    if (ra.line !== rb.line) {
      return ra.line - rb.line;
    }
    return ra.column - rb.column;
  });
  return out.slice(0, MAX_NAMED_DECL_MATCHES);
}

function sliceSourceByRange(
  sourceText: string,
  start: { line: number; column: number },
  end: { line: number; column: number },
): string {
  const lines = sourceText.split(/\r?\n/);
  let startOffset = 0;
  for (let i = 0; i < start.line; i++) {
    startOffset += (lines[i]?.length ?? 0) + 1;
  }
  startOffset += start.column;
  let endOffset = 0;
  for (let i = 0; i < end.line; i++) {
    endOffset += (lines[i]?.length ?? 0) + 1;
  }
  endOffset += end.column;
  return sourceText.slice(startOffset, endOffset);
}

/**
 * Declaration head without the body block (signature-only heuristic for navigation)
 */
export function sliceDeclarationSignature(sourceText: string, decl: SgNode): string {
  const k = decl.kind();
  const body = decl.field("body");
  if (
    body &&
    (k === "function_declaration" ||
      k === "method_definition" ||
      k === "class_declaration" ||
      k === "interface_declaration")
  ) {
    return sliceSourceByRange(sourceText, decl.range().start, body.range().start).trim();
  }
  if (k === "type_alias_declaration" || k === "enum_declaration") {
    return decl.text().trim();
  }
  if (k === "variable_declarator") {
    const val = decl.field("value");
    if (!val) {
      return decl.text().trim();
    }
    let head = sliceSourceByRange(sourceText, decl.range().start, val.range().start).trim();
    head = head.replace(/\s*=\s*$/, "").trim();
    return head;
  }
  return decl.text().split("{")[0]?.trim() ?? decl.text().trim();
}
