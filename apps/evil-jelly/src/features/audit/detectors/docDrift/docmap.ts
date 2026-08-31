/**
 * Document-domain registry for evil-jelly: symmetric doc-sync glob pairs plus the doc→code seed map.
 * Sync pairs are left/right glob rules; docs mappings are consumed by doc-drift validation.
 * Hand-written mappings stay at file level only: each workspace-relative doc path/glob maps to
 * coarse path prefixes (TS surface extraction) and/or artifact files (embedded verbatim, e.g.
 * jelly-lint's schema mirrors). Section→symbol detail is derived per run — never hand-maintained
 * here, so the map cannot rot at that granularity.
 */

import fg from "fast-glob";
import micromatch from "micromatch";
import { z } from "zod";
import { getSettings } from "../../../../shared/configuration/settings";
import { parseAndValidateJsonc } from "../../../../shared/foundation/jsonc";
import { getWorkspaceFiles } from "../../../../shared/fs-policy/workspace-files";

const DocMapEntrySchema = z
  .object({
    /** Workspace-relative path prefixes whose exported TS surface backs this doc. */
    paths: z.array(z.string()).optional(),
    /** Workspace-relative files embedded verbatim as the comparison surface (schemas, d.ts). */
    artifacts: z.array(z.string()).optional(),
    /** When set, the doc is excluded from validation; the value states why. */
    skip: z.string().optional(),
    /** Extra per-doc guidance injected into the evaluator prompt. */
    note: z.string().optional(),
  })
  .strict();

export const DocMapSchema = z
  .object({
    version: z.literal(1),
    sync: z
      .object({
        pairs: z.array(z.tuple([z.string().min(1), z.string().min(1)])).default([]),
      })
      .strict()
      .optional(),
    /** Keyed by workspace-relative doc path/glob. Non-glob keys are literal paths. */
    docs: z.record(z.string(), DocMapEntrySchema),
  })
  .strict()
  .superRefine((map, ctx) => {
    for (const [index, [leftGlob, rightGlob]] of (map.sync?.pairs ?? []).entries()) {
      const leftShape = wildcardShape(leftGlob);
      const rightShape = wildcardShape(rightGlob);
      if (
        leftShape.length !== rightShape.length ||
        leftShape.some((token, i) => token !== rightShape[i])
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sync", "pairs", index],
          message:
            `sync.pairs[${index}] wildcard shape mismatch: ` +
            `${leftGlob} (${leftShape.join(",") || "none"}) vs ` +
            `${rightGlob} (${rightShape.join(",") || "none"})`,
        });
      }
    }
  });

export type DocMapEntry = z.infer<typeof DocMapEntrySchema>;
export type DocMap = z.infer<typeof DocMapSchema>;

export interface ResolvedDocMapEntry {
  docFile: string;
  entry: DocMapEntry;
}

export interface ResolvedDocPair {
  leftFile: string;
  rightFile: string;
}

/** Parse + validate doc-map content. Throws with a clear message on malformed input. */
export function parseDocMap(raw: string, sourcePath: string): DocMap {
  return parseAndValidateJsonc(raw, "Doc map", sourcePath, DocMapSchema);
}

/** Workspace-relative doc-map path (--doc-map override → default). */
export function docMapPath(): string {
  return getSettings().docMap;
}

/**
 * Load the doc map from the workspace. Returns null when the file does not exist (doc-drift then
 * yields zero seeds); throws when the file exists but is malformed (a broken map must be fixed,
 * not silently skipped).
 */
export async function loadDocMap(): Promise<{ path: string; map: DocMap } | null> {
  const policy = getWorkspaceFiles();
  const relPath = docMapPath();
  let raw: string;
  try {
    raw = await policy.readFile(relPath);
  } catch {
    return null;
  }
  return { path: relPath, map: parseDocMap(raw, relPath) };
}

function hasGlobMagic(pattern: string): boolean {
  return /[*?[\]{}]/.test(pattern) || /(^|[/\\])[!+@]\(/.test(pattern);
}

async function expandDocGlob(key: string): Promise<string[]> {
  const normalized = key.replace(/\\/g, "/");
  const entries = await fg([normalized], {
    cwd: getWorkspaceFiles().getRoot(),
    dot: false,
    absolute: false,
    onlyFiles: true,
  });
  return entries.map((p) => p.replace(/\\/g, "/")).sort();
}

function normalizeRelPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+/, "");
}

function wildcardShape(pattern: string): Array<"*" | "**"> {
  const shape: Array<"*" | "**"> = [];
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] !== "*") {
      continue;
    }
    if (pattern[i + 1] === "*") {
      shape.push("**");
      i += 1;
    } else {
      shape.push("*");
    }
  }
  return shape;
}

function fillGlob(pattern: string, captures: string[]): string {
  let captureIndex = 0;
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] !== "*") {
      out += pattern[i];
      continue;
    }
    if (pattern[i + 1] === "*") {
      out += captures[captureIndex++] ?? "";
      if (pattern[i + 2] === "/" && out.endsWith("/")) {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    out += captures[captureIndex++] ?? "";
  }
  return normalizeRelPath(out);
}

async function expandSyncGlob(pattern: string): Promise<string[]> {
  const entries = await fg([normalizeRelPath(pattern)], {
    cwd: getWorkspaceFiles().getRoot(),
    dot: false,
    ignore: ["**/node_modules/**"],
    absolute: false,
    onlyFiles: true,
  });
  return entries.map((p) => p.replace(/\\/g, "/")).sort();
}

export async function resolveSyncPairs(
  map: DocMap,
  onWarning?: (warning: string) => void,
): Promise<ResolvedDocPair[]> {
  const resolved = new Map<string, ResolvedDocPair>();
  for (const [leftGlobRaw, rightGlobRaw] of map.sync?.pairs ?? []) {
    const leftGlob = normalizeRelPath(leftGlobRaw);
    const rightGlob = normalizeRelPath(rightGlobRaw);
    const [leftFiles, rightFiles] = await Promise.all([
      expandSyncGlob(leftGlob),
      expandSyncGlob(rightGlob),
    ]);

    if (leftFiles.length === 0 && rightFiles.length === 0) {
      const warning = `Doc sync pair matched no files: ${leftGlob} ⇄ ${rightGlob}`;
      console.warn(warning);
      onWarning?.(warning);
    }

    for (const leftFile of leftFiles) {
      const captures = micromatch.capture(leftGlob, leftFile);
      if (captures === null || captures === undefined) {
        continue;
      }
      const rightFile = fillGlob(rightGlob, captures);
      resolved.set(`${leftFile}\0${rightFile}`, { leftFile, rightFile });
    }

    for (const rightFile of rightFiles) {
      const captures = micromatch.capture(rightGlob, rightFile);
      if (captures === null || captures === undefined) {
        continue;
      }
      const leftFile = fillGlob(leftGlob, captures);
      resolved.set(`${leftFile}\0${rightFile}`, { leftFile, rightFile });
    }
  }

  return [...resolved.values()].sort(
    (a, b) => a.leftFile.localeCompare(b.leftFile) || a.rightFile.localeCompare(b.rightFile),
  );
}

function docDirname(docFile: string): string {
  const idx = docFile.lastIndexOf("/");
  return idx < 0 ? "" : docFile.slice(0, idx);
}

function expandEntryPlaceholders(docFile: string, entry: DocMapEntry): DocMapEntry {
  const dir = docDirname(docFile);
  const subst = (value: string) =>
    value
      .replace(/\$dir(?=\/|\\|$)/g, dir)
      .replace(/^\/+/, "")
      .replace(/\\/g, "/");
  return {
    ...(entry.paths !== undefined ? { paths: entry.paths.map(subst) } : {}),
    ...(entry.artifacts !== undefined ? { artifacts: entry.artifacts.map(subst) } : {}),
    ...(entry.skip !== undefined ? { skip: entry.skip } : {}),
    ...(entry.note !== undefined ? { note: entry.note } : {}),
  };
}

/**
 * Resolve doc-map keys to concrete workspace-relative Markdown files.
 *
 * Keys with glob magic are expanded first in map order; later globs override earlier glob matches.
 * Literal workspace-relative path keys are applied second and always override glob matches,
 * regardless of where they appear in the map. A key without `/` is still a literal path at the
 * workspace root, not a basename lookup.
 */
export async function resolveDocMapEntries(map: DocMap): Promise<ResolvedDocMapEntry[]> {
  const resolved = new Map<string, DocMapEntry>();
  const entries = Object.entries(map.docs);

  for (const [key, entry] of entries) {
    if (!hasGlobMagic(key)) {
      continue;
    }
    for (const docFile of await expandDocGlob(key)) {
      resolved.set(docFile, expandEntryPlaceholders(docFile, entry));
    }
  }

  for (const [key, entry] of entries) {
    if (hasGlobMagic(key)) {
      continue;
    }
    const docFile = key.replace(/\\/g, "/");
    resolved.set(docFile, expandEntryPlaceholders(docFile, entry));
  }

  return [...resolved.entries()]
    .map(([docFile, entry]) => ({ docFile, entry }))
    .sort((a, b) => a.docFile.localeCompare(b.docFile));
}
