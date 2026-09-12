/**
 * Outline, symbol-code, and workspace symbol listing for heuristic AST tools.
 */

import type { SgNode } from "@ast-grep/napi";
import type { ToolDefinition } from "@rejelly/core";
import { z } from "zod";
import { MAX_HEURISTIC_RESULTS } from "../source/heuristicAstLimits";
import { extractJsDocAbove, extractLeadingFileJsDoc } from "./jsdoc";
import {
  collectOutlineDeclarations,
  findNamedDeclarationAstNodes,
  type HeuristicSymbolKind,
  sliceDeclarationSignature,
} from "./queries";
import {
  collectMatchingDeclarations,
  getParsedAst,
  MAX_OUTPUT_CHARS,
  truncateJson,
} from "./shared";

export const astDocumentSymbolsParameters = z.object({
  filePath: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .describe("Path to one JS/TS file, or a non-empty array of paths."),
  include: z
    .enum(["all", "exported"])
    .optional()
    .default("all")
    .describe("Whether to include all outline declarations or only exported declarations."),
});

export const astWorkspaceSymbolsParameters = z.object({
  queryName: z.string().min(1).describe("Exact symbol name to match against declarations."),
  roots: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe("Optional files or directory roots to scan. Defaults to the workspace."),
  caseInsensitive: z
    .boolean()
    .optional()
    .default(false)
    .describe("When true, compares names case-insensitively."),
});

export const astReadSymbolCodeParameters = z.object({
  filePath: z.string().min(1).describe("Path to a JS/TS file."),
  symbolName: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .describe("Exact declaration name(s) to extract code blocks from."),
  caseInsensitive: z
    .boolean()
    .optional()
    .default(false)
    .describe("When true, matches declaration names case-insensitively."),
});

type AstDocumentSymbolsArgs = z.input<typeof astDocumentSymbolsParameters>;
type AstWorkspaceSymbolsArgs = z.infer<typeof astWorkspaceSymbolsParameters>;
type AstReadSymbolCodeArgs = z.infer<typeof astReadSymbolCodeParameters>;

function stripJsDocBlock(raw: string): string {
  return raw
    .replace(/^\/\*\*|\*\/$/g, "")
    .replace(/^\s*\*\s?/gm, "")
    .trim()
    .replace(/\s+/g, " ");
}

function extractInlineComment(lineText: string | undefined): string | undefined {
  if (!lineText) {
    return undefined;
  }
  const idx = lineText.indexOf("//");
  if (idx < 0) {
    return undefined;
  }
  const text = lineText.slice(idx + 2).trim();
  return text.length > 0 ? text : undefined;
}

function extractCommentBlockAbove(lines: string[], line: number): string | undefined {
  const index = line - 2;
  if (index < 0) {
    return undefined;
  }
  const direct = extractJsDocAbove(lines, line);
  if (direct) {
    return direct;
  }
  let i = index;
  while (i >= 0 && lines[i]?.trim().length === 0) {
    i -= 1;
  }
  if (i < 0) {
    return undefined;
  }
  if (lines[i]?.trim().endsWith("*/")) {
    const block: string[] = [];
    while (i >= 0) {
      const cur = lines[i] ?? "";
      block.unshift(cur);
      if (cur.trim().startsWith("/**")) {
        return block.join("\n");
      }
      i -= 1;
    }
  }
  if (lines[i]?.includes("//")) {
    const comments: string[] = [];
    while (i >= 0 && lines[i]?.trim().startsWith("//")) {
      comments.unshift(lines[i]!.trim().replace(/^\/\//, "").trim());
      i -= 1;
    }
    if (comments.length > 0) {
      return comments.join(" ");
    }
  }
  return undefined;
}

function isDeclarationExported(node: SgNode): boolean {
  let cur = node.parent();
  while (cur) {
    if (String(cur.kind()) === "export_statement") {
      return true;
    }
    if (String(cur.kind()) === "program") {
      return false;
    }
    cur = cur.parent();
  }
  return false;
}

const MAX_OUTLINE_DESCRIPTION_CHARS = 180;

type OutlineSymbol = {
  kind: HeuristicSymbolKind;
  name: string;
  line: number;
  depth: number;
  exported: boolean;
  compactSignature: string;
  description?: string;
};

type DocumentSymbolsFileOk = {
  file: string;
  moduleDoc?: string;
  symbols: OutlineSymbol[];
};

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateOneLine(text: string, max = MAX_OUTLINE_DESCRIPTION_CHARS): string {
  const compact = oneLine(text);
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

function findTopLevelChar(text: string, target: string): number {
  const openers: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };
  const closers = new Set(Object.values(openers));
  const stack: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (openers[char]) {
      stack.push(openers[char]);
    } else if (closers.has(char)) {
      if (stack.at(-1) === char) {
        stack.pop();
      }
    } else if (char === target && stack.length === 0) {
      return i;
    }
  }
  return -1;
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    const comma = findTopLevelChar(rest, ",");
    if (comma < 0) {
      parts.push(rest);
      break;
    }
    parts.push(rest.slice(0, comma));
    rest = rest.slice(comma + 1);
  }
  return parts;
}

function compactParameter(raw: string): string {
  let parameter = oneLine(raw).replace(/^(?:public|protected|private|readonly|override)\s+/, "");
  const equals = findTopLevelChar(parameter, "=");
  const hasDefault = equals >= 0;
  if (hasDefault) {
    parameter = parameter.slice(0, equals).trim();
  }
  const colon = findTopLevelChar(parameter, ":");
  if (colon >= 0) {
    parameter = parameter.slice(0, colon).trim();
  }
  if (hasDefault && !parameter.endsWith("?")) {
    parameter += "?";
  }
  return parameter;
}

function compactParameters(node: SgNode): string {
  const raw = node.field("parameters")?.text() ?? "()";
  const inner = raw.startsWith("(") && raw.endsWith(")") ? raw.slice(1, -1) : raw;
  return splitTopLevel(inner).map(compactParameter).filter(Boolean).join(", ");
}

function compactReturnType(node: SgNode): string {
  let returnType = oneLine(node.field("return_type")?.text() ?? "").replace(/^:\s*/, "");
  if (/^Promise<.*>$/.test(returnType)) {
    returnType = returnType.slice("Promise<".length, -1);
  }
  return returnType ? ` → ${returnType}` : "";
}

function variableKeyword(node: SgNode): string {
  const declaration = node.parent()?.text().trimStart() ?? "";
  return declaration.match(/^(const|let|var)\b/)?.[1] ?? "const";
}

function compactDeclarationSignature(
  kind: HeuristicSymbolKind,
  name: string,
  node: SgNode,
  sourceText: string,
): string {
  if (kind === "function" || kind === "method") {
    const head = oneLine(sliceDeclarationSignature(sourceText, node) || node.text());
    const asyncPrefix = /\basync\b/.test(head) ? "async " : "";
    const staticPrefix = kind === "method" && /\bstatic\b/.test(head) ? "static " : "";
    const callableName = kind === "function" ? `fn ${name}` : name;
    return `${staticPrefix}${asyncPrefix}${callableName}(${compactParameters(node)})${compactReturnType(node)}`;
  }
  if (kind === "variable") {
    return `${variableKeyword(node)} ${name}`;
  }
  if (kind === "type") {
    const typeParameters = oneLine(node.field("type_parameters")?.text() ?? "");
    return `type ${name}${typeParameters}`;
  }
  const raw = oneLine(sliceDeclarationSignature(sourceText, node) || node.text())
    .replace(/^(?:export\s+)?(?:default\s+)?/, "")
    .replace(/\s*\{$/, "")
    .trim();
  if (raw.startsWith(`${kind} `)) {
    return raw;
  }
  return `${kind} ${name}`;
}

function outlineDepth(node: SgNode): number {
  return node.kind() === "method_definition" && node.parent()?.kind() === "class_body" ? 1 : 0;
}

function collectReExportSymbols(lines: readonly string[]): OutlineSymbol[] {
  const symbols: OutlineSymbol[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(
      /^\s*export\s+((?:type\s+)?(?:\*\s*(?:as\s+\w+\s*)?|\{.*\})(?:\s+from\s+['"][^'"]+['"])?);?\s*$/,
    );
    if (!match?.[1]) continue;
    symbols.push({
      kind: "variable",
      name: match[1],
      line: index + 1,
      depth: 0,
      exported: true,
      compactSignature: oneLine(match[1]),
    });
  }
  return symbols;
}

function buildSymbolsForParsedFile(
  rel: string,
  text: string,
  root: Parameters<typeof collectOutlineDeclarations>[0],
  lang: Parameters<typeof collectOutlineDeclarations>[1],
): DocumentSymbolsFileOk {
  const lines = text.split(/\r?\n/);
  const moduleDocRaw = extractLeadingFileJsDoc(lines);
  const moduleDoc = moduleDocRaw ? truncateOneLine(stripJsDocBlock(moduleDocRaw)) : undefined;
  const declarations = collectOutlineDeclarations(root, lang).map(({ kind, name, node }) => {
    const line = node.range().start.line + 1;
    const rawDescription = extractCommentBlockAbove(lines, line);
    const inlineComment = extractInlineComment(lines[line - 1]);
    const description = rawDescription
      ? truncateOneLine(stripJsDocBlock(rawDescription))
      : inlineComment
        ? truncateOneLine(inlineComment)
        : undefined;
    return {
      kind,
      name,
      line,
      depth: outlineDepth(node),
      exported: isDeclarationExported(node),
      compactSignature: compactDeclarationSignature(kind, name, node, text),
      ...(description ? { description } : {}),
    };
  });
  const symbols = [...declarations, ...collectReExportSymbols(lines)].sort(
    (left, right) => left.line - right.line,
  );
  return {
    file: rel.replace(/\\/g, "/"),
    ...(moduleDoc ? { moduleDoc } : {}),
    symbols,
  };
}

function formatDocumentOutline(file: DocumentSymbolsFileOk, include: "all" | "exported"): string {
  const symbols = file.symbols.filter((symbol) => include === "all" || symbol.exported);
  const width = Math.max(1, ...symbols.map((symbol) => String(symbol.line).length));
  const output = [file.file, ""];
  if (file.moduleDoc) {
    output.push(`  # ${file.moduleDoc}`, "");
  }
  for (const symbol of symbols) {
    const exportPrefix = symbol.exported && symbol.depth === 0 ? "export " : "";
    const indent = "  ".repeat(symbol.depth);
    const description = symbol.description ? ` — ${symbol.description}` : "";
    output.push(
      `  ${String(symbol.line).padStart(width)}  ${indent}${exportPrefix}${symbol.compactSignature}${description}`,
    );
  }
  if (symbols.length === 0) {
    output.push("  (no matching symbols)");
  }
  return output.join("\n").trimEnd();
}

function truncateOutline(raw: string): string {
  return raw.length <= MAX_OUTPUT_CHARS
    ? raw
    : `${raw.slice(0, MAX_OUTPUT_CHARS)}\n... (truncated, max ${MAX_OUTPUT_CHARS} chars)`;
}

async function documentSymbolsForOneFile(
  filePath: string,
): Promise<string | DocumentSymbolsFileOk> {
  const parsed = await getParsedAst(filePath);
  if (!parsed.ok) {
    return parsed.error;
  }
  return buildSymbolsForParsedFile(parsed.rel, parsed.text, parsed.root, parsed.lang);
}

export async function astDocumentSymbolsService(args: AstDocumentSymbolsArgs): Promise<string> {
  const paths = Array.isArray(args.filePath) ? args.filePath : [args.filePath];
  const results = await Promise.all(paths.map((path) => documentSymbolsForOneFile(path)));
  const sections = results.map((result, index) => {
    if (typeof result === "string") {
      return `${paths[index]!.replace(/\\/g, "/")}\n\n  error: ${result}`;
    }
    return formatDocumentOutline(result, args.include ?? "all");
  });
  return truncateOutline(sections.join("\n\n"));
}

export async function astWorkspaceSymbolsService(args: AstWorkspaceSymbolsArgs): Promise<string> {
  const { queryName, caseInsensitive, roots } = args;
  let hits: Awaited<ReturnType<typeof collectMatchingDeclarations>>;
  try {
    hits = await collectMatchingDeclarations(queryName, caseInsensitive, roots);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return `AST workspace scan failed: ${message}`;
  }
  return truncateJson({
    queryName,
    roots: roots ?? ["."],
    matches: hits,
    truncated: hits.length >= MAX_HEURISTIC_RESULTS,
  });
}

function normalizeCodeSnippetNodeText(node: SgNode): string {
  const parent = node.parent();
  if (parent && String(parent.kind()) === "export_statement") {
    return parent.text();
  }
  if (String(node.kind()) === "variable_declarator") {
    const lexicalParent = node.parent();
    if (lexicalParent && String(lexicalParent.kind()) === "lexical_declaration") {
      return lexicalParent.text();
    }
  }
  return node.text();
}

export async function astReadSymbolCodeService(args: AstReadSymbolCodeArgs): Promise<string> {
  const { filePath, symbolName, caseInsensitive } = args;
  const parsed = await getParsedAst(filePath);
  if (!parsed.ok) {
    return parsed.error;
  }
  const { rel, root, text, lang } = parsed;
  const lines = text.split(/\r?\n/);
  const names = Array.isArray(symbolName) ? symbolName : [symbolName];
  const relOut = rel.replace(/\\/g, "/");
  const results: Array<{
    symbolName: string;
    matches: Array<{
      kind: string;
      line: number;
      signature: string | null;
      jsDoc: string | null;
      code: string;
    }>;
  }> = [];
  for (const q of names) {
    const nodes = findNamedDeclarationAstNodes(root, q, caseInsensitive, lang);
    results.push({
      symbolName: q,
      matches: nodes.map((node) => {
        const line = node.range().start.line + 1;
        const rawJsdoc = extractCommentBlockAbove(lines, line);
        return {
          kind: String(node.kind()),
          line,
          signature: sliceDeclarationSignature(text, node),
          jsDoc: rawJsdoc ? stripJsDocBlock(rawJsdoc) : null,
          code: normalizeCodeSnippetNodeText(node),
        };
      }),
    });
  }
  return truncateJson({ file: relOut, results });
}

export const AstDocumentSymbolsTool: ToolDefinition<typeof astDocumentSymbolsParameters> = {
  name: "ast_document_symbols",
  description:
    "Compact source-order outline of top-level classes, interfaces, types, enums, functions, class methods, and module-level const/let. " +
    "Pass one filePath or batch several files; use include to keep all declarations or only exports, including re-export statements. " +
    "Returns one symbol per line with compact signatures and indented class members, omitting empty metadata. " +
    "Ignores locals inside functions, arrows, and object-literal methods.",
  parameters: astDocumentSymbolsParameters,
  handler: async (args) => astDocumentSymbolsService(args),
};

export const AstWorkspaceSymbolsTool: ToolDefinition<typeof astWorkspaceSymbolsParameters> = {
  name: "ast_workspace_symbols",
  description:
    "Search files for declarations (class, function, interface, type, enum, method, variable) whose name matches queryName. " +
    "Pass roots to search selected files or directories. " +
    "Heuristic only — no type-aware binding; multiple hits are common.",
  parameters: astWorkspaceSymbolsParameters,
  handler: async (args) => astWorkspaceSymbolsService(args),
};

export const AstReadSymbolCodeTool: ToolDefinition<typeof astReadSymbolCodeParameters> = {
  name: "ast_read_symbol_code",
  description:
    "Read declaration code blocks by symbol name from one file (AST-scoped deep dive). " +
    "Returns signature, JSDoc summary, and declaration source blocks without full-file reads.",
  parameters: astReadSymbolCodeParameters,
  handler: async (args) => astReadSymbolCodeService(args),
};
