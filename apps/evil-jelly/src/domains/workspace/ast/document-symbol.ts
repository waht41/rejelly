/**
 * Outline / read-symbol / workspace symbol listing for heuristic AST tools.
 */

import type { SgNode } from "@ast-grep/napi";
import type { ToolDefinition } from "@rejelly/core";
import { z } from "zod";
import { MAX_HEURISTIC_RESULTS } from "../source/heuristicAstLimits";
import { extractJsDocAbove, extractLeadingFileJsDoc } from "./jsdoc";
import {
  collectDocumentSymbols,
  findNamedDeclarationAstNodes,
  sliceDeclarationSignature,
} from "./queries";
import { collectMatchingDeclarations, getParsedAst, MAX_JSDOC_CHARS, truncateJson } from "./shared";

export const astDocumentSymbolsParameters = z.object({
  filePath: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .describe(
      "Workspace-relative path to one JS/TS file, or a non-empty array of paths (batched outline).",
    ),
});

export const astReadSymbolParameters = z.object({
  filePath: z.string().min(1).describe("Workspace-relative path to a JS/TS file."),
  symbolName: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .describe("Exact declaration name(s): function, class, const, method, type, etc."),
  caseInsensitive: z
    .boolean()
    .optional()
    .default(false)
    .describe("When true, matches declaration names case-insensitively."),
});

export const astWorkspaceSymbolsParameters = z.object({
  queryName: z.string().min(1).describe("Exact symbol name to match against declarations."),
  caseInsensitive: z
    .boolean()
    .optional()
    .default(false)
    .describe("When true, compares names case-insensitively."),
});

export const astReadSymbolCodeParameters = z.object({
  filePath: z.string().min(1).describe("Workspace-relative path to a JS/TS file."),
  symbolName: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .describe("Exact declaration name(s) to extract code blocks from."),
  caseInsensitive: z
    .boolean()
    .optional()
    .default(false)
    .describe("When true, matches declaration names case-insensitively."),
});

export const astModuleExportsParameters = z.object({
  filePath: z.string().min(1).describe("Workspace-relative path to a JS/TS module."),
});

type AstDocumentSymbolsArgs = z.infer<typeof astDocumentSymbolsParameters>;
type AstReadSymbolArgs = z.infer<typeof astReadSymbolParameters>;
type AstWorkspaceSymbolsArgs = z.infer<typeof astWorkspaceSymbolsParameters>;
type AstReadSymbolCodeArgs = z.infer<typeof astReadSymbolCodeParameters>;
type AstModuleExportsArgs = z.infer<typeof astModuleExportsParameters>;
type ModuleExportEntry = {
  kind: string;
  name: string;
  line: number;
  signature?: string | null;
  description?: string | null;
  source?: string | null;
  isTypeOnly?: boolean;
  importedName?: string | null;
  exportedName?: string | null;
};

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

function pickNodeForSymbolLine(
  nodes: ReturnType<typeof findNamedDeclarationAstNodes>,
  targetLine: number,
): ReturnType<typeof findNamedDeclarationAstNodes>[number] | undefined {
  if (nodes.length === 0) {
    return undefined;
  }
  const exact = nodes.find((n) => n.range().start.line + 1 === targetLine);
  if (exact) {
    return exact;
  }
  return [...nodes].sort(
    (a, b) =>
      Math.abs(a.range().start.line + 1 - targetLine) -
      Math.abs(b.range().start.line + 1 - targetLine),
  )[0];
}

function buildSymbolsForParsedFile(
  rel: string,
  text: string,
  root: Parameters<typeof collectDocumentSymbols>[0],
  lang: Parameters<typeof collectDocumentSymbols>[1],
) {
  const lines = text.split(/\r?\n/);
  const moduleDocRaw = extractLeadingFileJsDoc(lines);
  const moduleDoc =
    moduleDocRaw === undefined
      ? undefined
      : (() => {
          const stripped = stripJsDocBlock(moduleDocRaw);
          return stripped.length > MAX_JSDOC_CHARS
            ? `${stripped.slice(0, MAX_JSDOC_CHARS)}…`
            : stripped;
        })();
  const symbols = collectDocumentSymbols(root, lang)
    .map((sym) => {
      const declarationNodes = findNamedDeclarationAstNodes(root, sym.name, false, lang);
      const pickedNode = pickNodeForSymbolLine(declarationNodes, sym.line);
      const targetLine = pickedNode ? pickedNode.range().start.line + 1 : sym.line;
      const raw = extractCommentBlockAbove(lines, targetLine);
      const signature = pickedNode ? sliceDeclarationSignature(text, pickedNode) : undefined;
      const inlineComment = extractInlineComment(lines[sym.line - 1]);
      const jsDocSummary =
        !raw || raw.length === 0
          ? undefined
          : (() => {
              const stripped = stripJsDocBlock(raw);
              return stripped.length > MAX_JSDOC_CHARS
                ? `${stripped.slice(0, MAX_JSDOC_CHARS)}…`
                : stripped;
            })();
      return {
        ...sym,
        exported: pickedNode ? isDeclarationExported(pickedNode) : false,
        signature: signature ?? null,
        description: jsDocSummary ?? inlineComment ?? null,
        ...(inlineComment ? { inlineComment } : {}),
      };
    })
    .sort((a, b) => {
      if (a.exported !== b.exported) {
        return a.exported ? -1 : 1;
      }
      if (a.line !== b.line) {
        return a.line - b.line;
      }
      return a.name.localeCompare(b.name);
    });
  const relOut = rel.replace(/\\/g, "/");
  return {
    file: relOut,
    ...(moduleDoc !== undefined ? { moduleDoc } : {}),
    symbols,
  };
}

type DocumentSymbolsFileOk = ReturnType<typeof buildSymbolsForParsedFile>;

type DocumentSymbolsBatchEntry = DocumentSymbolsFileOk | { file: string; error: string };

/** One file: same JSON payload as before on success, or a plain error string on failure. */
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
  const raw = args.filePath;
  const paths = Array.isArray(raw) ? raw : [raw];
  if (paths.length === 1) {
    const r = await documentSymbolsForOneFile(paths[0]!);
    if (typeof r === "string") {
      return r;
    }
    return truncateJson(r);
  }
  const results = await Promise.all(paths.map((p) => documentSymbolsForOneFile(p)));
  const files: DocumentSymbolsBatchEntry[] = [];
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i]!;
    const inputPath = paths[i]!.replace(/\\/g, "/");
    if (typeof r === "string") {
      files.push({ file: inputPath, error: r });
    } else {
      files.push(r);
    }
  }
  return truncateJson({ files });
}

export async function astReadSymbolService(args: AstReadSymbolArgs): Promise<string> {
  const { filePath, symbolName, caseInsensitive } = args;
  const parsed = await getParsedAst(filePath);
  if (!parsed.ok) {
    return parsed.error;
  }
  const { rel, root, lang } = parsed;
  const names = Array.isArray(symbolName) ? symbolName : [symbolName];
  const relOut = rel.replace(/\\/g, "/");
  const results: Array<{
    symbolName: string;
    matches: Array<{ kind: string; line: number; text: string }>;
  }> = [];
  for (const q of names) {
    const nodes = findNamedDeclarationAstNodes(root, q, caseInsensitive, lang);
    results.push({
      symbolName: q,
      matches: nodes.map((node) => ({
        kind: String(node.kind()),
        line: node.range().start.line + 1,
        text: node.text(),
      })),
    });
  }
  return truncateJson({ file: relOut, results });
}

export async function astWorkspaceSymbolsService(args: AstWorkspaceSymbolsArgs): Promise<string> {
  const { queryName, caseInsensitive } = args;
  const hits = await collectMatchingDeclarations(queryName, caseInsensitive);
  return truncateJson({
    queryName,
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

export async function astModuleExportsService(args: AstModuleExportsArgs): Promise<string> {
  const parsed = await getParsedAst(args.filePath);
  if (!parsed.ok) {
    return parsed.error;
  }
  const sourceLines = parsed.text.split(/\r?\n/);
  const base = JSON.parse(await astDocumentSymbolsService({ filePath: args.filePath })) as {
    file: string;
    symbols: Array<{
      kind: string;
      name: string;
      line: number;
      exported?: boolean;
      signature?: string | null;
      description?: string | null;
    }>;
  };
  const declarationExports: ModuleExportEntry[] = (base.symbols ?? [])
    .filter((sym) => sym.exported === true)
    .map((sym) => ({
      kind: sym.kind,
      name: sym.name,
      line: sym.line,
      signature: sym.signature ?? null,
      description: sym.description ?? null,
      source: null,
      isTypeOnly: sym.kind === "type" || sym.kind === "interface",
      importedName: null,
      exportedName: sym.name,
    }));

  const reExports: ModuleExportEntry[] = [];
  for (let i = 0; i < sourceLines.length; i += 1) {
    const line = sourceLines[i] ?? "";
    const lineNo = i + 1;
    const exportAll = line.match(/^\s*export\s+(type\s+)?\*\s+from\s+['"]([^'"]+)['"]/);
    if (exportAll) {
      reExports.push({
        kind: "re-export-all",
        name: "*",
        line: lineNo,
        signature: null,
        description: null,
        source: exportAll[2] ?? null,
        isTypeOnly: Boolean(exportAll[1]),
        importedName: "*",
        exportedName: "*",
      });
      continue;
    }
    const exportNamed = line.match(/^\s*export\s+(type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
    if (exportNamed) {
      const typeOnly = Boolean(exportNamed[1]);
      const members = (exportNamed[2] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const member of members) {
        const aliasMatch = member.match(/^(.+?)\s+as\s+(.+)$/);
        const imported = (aliasMatch ? aliasMatch[1] : member).replace(/^type\s+/, "").trim();
        const exported = (aliasMatch ? aliasMatch[2] : member).replace(/^type\s+/, "").trim();
        reExports.push({
          kind: "re-export",
          name: exported,
          line: lineNo,
          signature: null,
          description: null,
          source: exportNamed[3] ?? null,
          isTypeOnly: typeOnly || member.startsWith("type "),
          importedName: imported,
          exportedName: exported,
        });
      }
    }
  }
  const dedupe = new Set<string>();
  const exportsOnly = [...declarationExports, ...reExports].filter((entry) => {
    const key = `${entry.kind}|${entry.name}|${entry.line}|${entry.source ?? ""}`;
    if (dedupe.has(key)) {
      return false;
    }
    dedupe.add(key);
    return true;
  });
  return truncateJson({
    file: base.file,
    exports: exportsOnly,
    totalExports: exportsOnly.length,
  });
}

export const AstDocumentSymbolsTool: ToolDefinition<typeof astDocumentSymbolsParameters> = {
  name: "ast_document_symbols",
  description:
    "Outline-style list: top-level (module-scope) classes, interfaces, types, enums, functions, class methods, and module-level const/let. " +
    "Pass a single filePath string or a non-empty array to batch several files; multi-file results are wrapped in { files: [...] } with the same per-file fields as a single call. " +
    "Ignores locals inside functions, arrows, and object-literal methods (same idea as IDE Outline). " +
    "Includes optional leading file JSDoc (moduleDoc) and per-symbol JSDoc when adjacent to the declaration.",
  parameters: astDocumentSymbolsParameters,
  handler: async (args) => astDocumentSymbolsService(args),
};

export const AstReadSymbolTool: ToolDefinition<typeof astReadSymbolParameters> = {
  name: "ast_read_symbol",
  description:
    "In one file, find declaration AST node(s) whose bound name equals symbolName (any depth: nested functions, methods, locals). " +
    "Returns each node's raw source span via node.text(). Multiple names may be passed as an array.",
  parameters: astReadSymbolParameters,
  handler: async (args) => astReadSymbolService(args),
};

export const AstWorkspaceSymbolsTool: ToolDefinition<typeof astWorkspaceSymbolsParameters> = {
  name: "ast_workspace_symbols",
  description:
    "Search the workspace for declarations (class, function, interface, type, enum, method, variable) whose name matches queryName. " +
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

export const AstModuleExportsTool: ToolDefinition<typeof astModuleExportsParameters> = {
  name: "ast_module_exports",
  description:
    "List exported declarations in one module for structural skim (filters out internal non-export symbols).",
  parameters: astModuleExportsParameters,
  handler: async (args) => astModuleExportsService(args),
};
