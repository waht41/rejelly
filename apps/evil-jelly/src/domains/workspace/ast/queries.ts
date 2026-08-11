import { Lang, parse, type SgNode } from "@ast-grep/napi";
import { escapeRegexLiteral } from "../../../shared/lib/string";
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

  rows.sort(
    (a, b) => a.node.range().start.line - b.node.range().start.line || a.name.localeCompare(b.name),
  );
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
 * Sorted by start position. Used by ast_read_symbol to return node.text().
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

const CALLABLE_KINDS = new Set<string>([
  "arrow_function",
  "function_expression",
  "function_declaration",
  "method_definition",
]);

function isCallableScopeNode(n: SgNode): boolean {
  return CALLABLE_KINDS.has(String(n.kind()));
}

/** Same AST callable envelope (SgNode wrappers may differ by identity). */
function callableEnvelopeMatches(inner: SgNode | undefined, envelope: SgNode): boolean {
  if (!inner) {
    return false;
  }
  const ra = inner.range().start;
  const rb = envelope.range().start;
  return (
    ra.line === rb.line &&
    ra.column === rb.column &&
    String(inner.kind()) === String(envelope.kind())
  );
}

/**
 * Innermost function/method/arrow that lexically encloses this node (excluding the node itself).
 */
export function innermostCallableAncestor(node: SgNode): SgNode | undefined {
  let cur = node.parent();
  while (cur) {
    if (isCallableScopeNode(cur)) {
      return cur;
    }
    cur = cur.parent();
  }
  return undefined;
}

function collectPatternBindingNames(pattern: SgNode | null | undefined): string[] {
  if (!pattern) {
    return [];
  }
  if (pattern.kind() === "identifier") {
    return [pattern.text()];
  }
  if (pattern.kind() === "rest_pattern") {
    const ids = pattern.findAll({ rule: { kind: "identifier" } });
    return ids.map((n) => n.text());
  }
  return pattern.findAll({ rule: { kind: "identifier" } }).map((n) => n.text());
}

function collectParameterBindingNames(
  formalParameters: SgNode | null | undefined,
  lang: Lang,
): string[] {
  if (!formalParameters) {
    return [];
  }
  const names: string[] = [];
  if (lang === Lang.JavaScript) {
    // The JS grammar has no required_parameter/optional_parameter wrappers; the
    // parameter patterns are direct children of formal_parameters (punctuation
    // children yield no identifiers and fall through harmlessly).
    for (const p of formalParameters.children()) {
      names.push(...collectPatternBindingNames(p));
    }
    return names;
  }
  for (const k of ["required_parameter", "optional_parameter"] as const) {
    for (const p of formalParameters.findAll({ rule: { kind: k } })) {
      names.push(...collectPatternBindingNames(p.field("pattern")));
    }
  }
  return names;
}

/**
 * Bindings declared directly in this callable's scope (not in nested functions).
 */
export function collectBindingsForCallableEnvelope(envelope: SgNode, lang: Lang): Set<string> {
  const body = envelope.field("body");
  const s = new Set<string>();
  for (const n of collectParameterBindingNames(envelope.field("parameters"), lang)) {
    s.add(n);
  }
  if (!body) {
    return s;
  }
  for (const vd of body.findAll({ rule: { kind: "variable_declarator" } })) {
    if (!callableEnvelopeMatches(innermostCallableAncestor(vd), envelope)) {
      continue;
    }
    const nameNode = vd.field("name");
    if (nameNode?.kind() === "identifier") {
      s.add(nameNode.text());
    } else if (nameNode) {
      for (const id of nameNode.findAll({ rule: { kind: "identifier" } })) {
        s.add(id.text());
      }
    }
  }
  for (const fd of body.findAll({ rule: { kind: "function_declaration" } })) {
    if (!callableEnvelopeMatches(innermostCallableAncestor(fd), envelope)) {
      continue;
    }
    const nm = fd.field("name")?.text();
    if (nm) {
      s.add(nm);
    }
  }
  return s;
}

function calleeSymbolFromCallLike(callNode: SgNode): string | undefined {
  const k = callNode.kind();
  if (k === "call_expression") {
    const fnNode = callNode.field("function");
    if (!fnNode) {
      return undefined;
    }
    if (fnNode.kind() === "identifier") {
      return fnNode.text();
    }
    if (fnNode.kind() === "member_expression") {
      const prop = fnNode.field("property");
      if (prop?.kind() === "property_identifier" || prop?.kind() === "identifier") {
        return prop.text();
      }
    }
    return undefined;
  }
  if (k === "new_expression") {
    const cons = callNode.field("constructor");
    if (!cons) {
      return undefined;
    }
    if (cons.kind() === "identifier") {
      return cons.text();
    }
    if (cons.kind() === "member_expression") {
      const prop = cons.field("property");
      if (prop?.kind() === "property_identifier" || prop?.kind() === "identifier") {
        return prop.text();
      }
    }
    return undefined;
  }
  return undefined;
}

/**
 * Collect callee symbol names that are not bound in the innermost enclosing callable scope.
 */
export function extractExternalCalleeSymbols(body: SgNode, lang: Lang): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const calls = [
    ...body.findAll({ rule: { kind: "call_expression" } }),
    ...body.findAll({ rule: { kind: "new_expression" } }),
  ];
  for (const call of calls) {
    const sym = calleeSymbolFromCallLike(call);
    if (!sym) {
      continue;
    }
    const env = innermostCallableAncestor(call);
    if (!env) {
      continue;
    }
    const locals = collectBindingsForCallableEnvelope(env, lang);
    if (locals.has(sym)) {
      continue;
    }
    if (!seen.has(sym)) {
      seen.add(sym);
      out.push(sym);
    }
  }
  return out;
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

export function pickOutlineDeclaration(nodes: SgNode[]): SgNode | undefined {
  const outline = nodes.filter(isModuleOutlineDeclaration);
  return outline[0] ?? nodes[0];
}

/**
 * First matching function_declaration, method_definition, or const arrow/function in document order.
 */
export function findCallableDeclarationForSymbol(
  root: SgNode,
  symbolName: string,
  caseInsensitive: boolean,
): SgNode | undefined {
  const match = (name: string | undefined) =>
    name !== undefined && matchDeclarationName(symbolName, name, caseInsensitive);

  for (const n of root.findAll({ rule: { kind: "function_declaration" } })) {
    if (match(n.field("name")?.text())) {
      return n;
    }
  }
  for (const n of root.findAll({ rule: { kind: "method_definition" } })) {
    if (match(n.field("name")?.text())) {
      return n;
    }
  }
  for (const n of root.findAll({ rule: { kind: "variable_declarator" } })) {
    const id = n.field("name");
    const val = n.field("value");
    if (id?.kind() !== "identifier" || !match(id.text())) {
      continue;
    }
    const vk = val?.kind();
    if (vk === "arrow_function" || vk === "function_expression") {
      return n;
    }
  }
  return undefined;
}

/**
 * Arrow/function envelope for a callable declaration (variable_declarator uses its value node).
 */
export function getCallableEnvelope(decl: SgNode): SgNode | undefined {
  const k = decl.kind();
  if (k === "function_declaration" || k === "method_definition") {
    return decl;
  }
  if (k === "variable_declarator") {
    const val = decl.field("value");
    const vk = val?.kind();
    if (vk === "arrow_function" || vk === "function_expression") {
      return val ?? undefined;
    }
  }
  return undefined;
}

export function enclosingCallableName(node: SgNode): string | undefined {
  let cur: SgNode | null | undefined = node.parent();
  while (cur) {
    const k = cur.kind();
    if (k === "function_declaration") {
      return cur.field("name")?.text();
    }
    if (k === "method_definition") {
      return cur.field("name")?.text();
    }
    if (k === "arrow_function") {
      const parent = cur.parent();
      if (parent?.kind() === "variable_declarator") {
        const id = parent.field("name");
        if (id?.kind() === "identifier") {
          return id.text();
        }
      }
      return "(anonymous arrow)";
    }
    cur = cur.parent();
  }
  return undefined;
}

/** First relative `from '...'` module path in an import that references `symbolName`. */
export function extractNamedImportModuleForSymbol(
  code: string,
  lang: Lang,
  symbolName: string,
): string | null {
  const root = parse(lang, code).root();
  const symRe = new RegExp(`\\b${escapeRegexLiteral(symbolName)}\\b`);
  for (const imp of root.findAll({ rule: { kind: "import_statement" } })) {
    const text = imp.text();
    if (!symRe.test(text)) {
      continue;
    }
    const m = text.match(/\bfrom\s+['"]([^'"]+)['"]/);
    if (!m) {
      continue;
    }
    return m[1];
  }
  return null;
}
