/** JS/TS declaration and documentation extraction for audit surface snapshots. */

import { Lang, type SgNode } from "@ast-grep/napi";

/** ast-grep rejects kinds absent from the parsed language's grammar. */
const TS_ONLY_KINDS: ReadonlySet<string> = new Set([
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
]);

function findAllOfKind(node: SgNode, kind: string, lang: Lang): SgNode[] {
  if (lang === Lang.JavaScript && TS_ONLY_KINDS.has(kind)) {
    return [];
  }
  return node.findAll({ rule: { kind } });
}

export type SurfaceSymbolKind =
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "function"
  | "method"
  | "variable";

/** Exclude declarations inside functions, arrows, and object-literal methods. */
function isModuleOutlineDeclaration(declNode: SgNode): boolean {
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
    if (k === "function_declaration" || k === "method_definition") {
      return false;
    }
    cur = cur.parent();
  }
  return false;
}

type OutlineDeclaration = {
  kind: SurfaceSymbolKind;
  name: string;
  node: SgNode;
};

export function collectOutlineDeclarations(root: SgNode, lang: Lang): OutlineDeclaration[] {
  const rows: OutlineDeclaration[] = [];
  const push = (kind: SurfaceSymbolKind, node: SgNode, name: string) => {
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

/** Declaration head without the body block or variable initializer. */
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

export function extractJsDocAbove(lines: string[], declLine1Based: number): string | undefined {
  const idx = declLine1Based - 1;
  if (idx <= 0) {
    return undefined;
  }
  let end = idx - 1;
  while (end >= 0 && lines[end].trim() === "") {
    end--;
  }
  if (end < 0) {
    return undefined;
  }
  const line = lines[end].trim();
  if (!line.startsWith("/**")) {
    return undefined;
  }
  const block: string[] = [];
  let i = end;
  while (i >= 0) {
    block.unshift(lines[i]);
    if (lines[i].includes("*/")) {
      break;
    }
    i--;
  }
  if (!block.some((l) => l.includes("*/"))) {
    return undefined;
  }
  return block.join("\n").trim();
}
