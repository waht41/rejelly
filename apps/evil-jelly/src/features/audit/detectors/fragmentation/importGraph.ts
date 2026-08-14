/**
 * Feature-internal relative import graph for the fragmentation detector (INV-0008, Phase 1).
 *
 * Only `./` / `../` specifiers are followed: relative edges need no resolver, tsconfig alias map, or
 * node_modules walk, so they are trivially reliable — and the fragmentation smell does not care about
 * the cross-package / aliased edges that make full resolution hard. Resolution is done in-memory against
 * the known file set (identical for the workspace and IO-free callers), so no per-import filesystem stat.
 *
 * Caveat: a satellite also imported via a non-relative alias would look single-consumer here. This repo
 * imports internally with relative paths throughout, so that gap is empty in practice; the family's
 * "≥2 external consumers ⇒ not a fragment" reasoning is the backstop if that ever changes.
 */

import path from "node:path";
import { parse } from "@ast-grep/napi";
import { langFromRelPath } from "../../../../domains/workspace/source/sourceLanguage";

export interface FragmentationSource {
  /** Workspace-relative posix path. */
  file: string;
  /** Full file contents. */
  code: string;
}

export interface ImportGraph {
  /** importersOf.get(target) = the set of files importing `target` via a relative edge. */
  importersOf: Map<string, Set<string>>;
  /** Total distinct relative edges resolved. */
  edgeCount: number;
  /** Files whose import statements parsed successfully. */
  filesParsed: number;
}

/** Candidate file paths a relative specifier could resolve to, in priority order. */
const RESOLVE_EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const RESOLVE_INDEXES = [
  "/index.ts",
  "/index.tsx",
  "/index.mts",
  "/index.cts",
  "/index.js",
  "/index.jsx",
];

const FROM_RE = /\bfrom\s*['"]([^'"]+)['"]/;
const BARE_IMPORT_RE = /^\s*import\s*['"]([^'"]+)['"]/;

/**
 * Extract the relative module specifiers (`import`/`export ... from`, plus bare side-effect imports)
 * declared in one source. Returns null when the file does not parse (so callers can count parse failures).
 */
export function extractRelativeSpecifiers(code: string, file: string): string[] | null {
  let root: ReturnType<ReturnType<typeof parse>["root"]>;
  try {
    root = parse(langFromRelPath(file), code).root();
  } catch {
    return null;
  }
  const specs: string[] = [];
  const nodes = [
    ...root.findAll({ rule: { kind: "import_statement" } }),
    ...root.findAll({ rule: { kind: "export_statement" } }),
  ];
  for (const node of nodes) {
    const text = node.text();
    const match = FROM_RE.exec(text) ?? BARE_IMPORT_RE.exec(text);
    if (match?.[1].startsWith(".")) {
      specs.push(match[1]);
    }
  }
  return specs;
}

/** Resolve a relative specifier to a known workspace file, or null if it points outside the set. */
export function resolveRelative(
  fromFile: string,
  specifier: string,
  known: Set<string>,
): string | null {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = joined + ext;
    if (known.has(candidate)) {
      return candidate;
    }
  }
  for (const index of RESOLVE_INDEXES) {
    const candidate = joined + index;
    if (known.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Build the reverse (importers) relative-edge graph over a set of sources. */
export function buildImportGraph(sources: FragmentationSource[]): ImportGraph {
  const known = new Set(sources.map((s) => s.file));
  const importersOf = new Map<string, Set<string>>();
  let edgeCount = 0;
  let filesParsed = 0;

  for (const { file, code } of sources) {
    const specs = extractRelativeSpecifiers(code, file);
    if (specs === null) {
      continue;
    }
    filesParsed++;
    for (const spec of specs) {
      const target = resolveRelative(file, spec, known);
      if (target === null || target === file) {
        continue;
      }
      let importers = importersOf.get(target);
      if (!importers) {
        importers = new Set<string>();
        importersOf.set(target, importers);
      }
      if (!importers.has(file)) {
        importers.add(file);
        edgeCount++;
      }
    }
  }

  return { importersOf, edgeCount, filesParsed };
}
