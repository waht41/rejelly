/**
 * edit_file / create_file with host-gated writes (no silent disk mutation).
 */

import path from "node:path";
import type { ToolDefinition } from "@rejelly/core";
import { z } from "zod";
import type { ToolConfirmationHandler, WriteActionType } from "../shared/AgentShared";
import {
  AGENT_SCRATCH_DIR,
  getWorkspaceFsPolicy,
  type ResolvedFsPath,
  type WorkspaceFsPolicy,
} from "../shared/fs-policy/workspace-fs-policy";
import { applyBlockEdits } from "../shared/lib/blockReplace";
import { getErrnoCode } from "../shared/lib/errors";
import { normalizeNewlines } from "../shared/lib/string";
import { createTwoFilesPatch } from "../shared/lib/unifiedDiff";
import { MAX_READ_BYTES_PER_CALL } from "./FileSystemTools";
import { resolveToolFsPath } from "./outsideAccess";

const MAX_WRITE_BYTES = MAX_READ_BYTES_PER_CALL;

/** Refactor tools expose full host actions (binary-only callers omit or narrow supportedActions). */
const REFACTOR_WRITE_ACTIONS: WriteActionType[] = ["accept", "reject", "edit", "retry"];
const BATCH_REFACTOR_WRITE_ACTIONS: WriteActionType[] = ["accept", "reject", "retry"];

const editBlockSchema = z.object({
  searchBlock: z
    .string()
    .describe(
      "Contiguous old code to replace (from read_file). Prefer exact text; indentation may match via line-trim fallback. " +
        "Empty string replaces the whole file (only valid as the sole edit). Use '@head' to prepend or '@end' to append.",
    ),
  replaceBlock: z.string().describe("New code to substitute for the matched region."),
});

const singleFileEditSchema = z.object({
  filePath: z
    .string()
    .describe("Path to edit. Workspace-outside paths require approval before the diff review."),
  edits: z
    .array(editBlockSchema)
    .min(1)
    .describe(
      "Edits applied sequentially on normalized (LF) content. When using multiple edits, base every searchBlock on the ORIGINAL file " +
        "and order edits bottom-to-top (end of file first) so earlier replacements do not shift later matches.",
    ),
});

const editFileParameters = z.object({
  targets: z
    .array(singleFileEditSchema)
    .min(1)
    .describe(
      "Batch input: [{ filePath, edits }, ...] for one confirm step across files. " +
        "Repeating a filePath is allowed; its edits are merged in order into a single per-file edit list.",
    ),
});

const singleFileCreateSchema = z.object({
  filePath: z
    .string()
    .describe(
      `Path to create; parent directories are created when missing. Use ${AGENT_SCRATCH_DIR}/ for temporary scripts and intermediate files.`,
    ),
  content: z.string().describe("Full file contents (UTF-8)."),
});

const createFileParameters = z.object({
  targets: z
    .array(singleFileCreateSchema)
    .min(1)
    .describe("Batch input: [{ filePath, content }, ...] for one confirm step across files."),
});

const deleteFileParameters = z.object({
  targetPaths: z
    .array(z.string())
    .min(1)
    .describe("Relative file or directory paths to delete in one batch."),
});

type DeleteTargetInput = z.infer<typeof deleteFileParameters>;

function makePatch(filePath: string, oldStr: string, newStr: string): string {
  const oldN = normalizeNewlines(oldStr);
  const newN = normalizeNewlines(newStr);
  return createTwoFilesPatch(filePath, oldN, newN);
}

type ExistingDeleteTarget = {
  filePath: string;
  rel: string;
  isDirectory: boolean;
  size: number;
};

async function buildDeleteUnifiedDiff(
  policy: WorkspaceFsPolicy,
  targets: ExistingDeleteTarget[],
): Promise<string> {
  const chunks: string[] = [];
  for (const target of targets) {
    if (target.isDirectory) {
      chunks.push(
        `diff --git a/${target.filePath} b/${target.filePath}\n` +
          `deleted directory mode 040000\n` +
          `--- a/${target.filePath}\n` +
          "+++ /dev/null\n",
      );
      continue;
    }

    if (target.size > MAX_WRITE_BYTES) {
      chunks.push(
        `diff --git a/${target.filePath} b/${target.filePath}\n` +
          `deleted file mode 100644\n` +
          `--- a/${target.filePath}\n` +
          "+++ /dev/null\n" +
          "@@\n" +
          `-<content omitted: ${target.size} bytes exceeds ${MAX_WRITE_BYTES} preview limit>\n`,
      );
      continue;
    }

    try {
      const raw = await policy.readFile(target.rel);
      chunks.push(makePatch(target.filePath, raw, ""));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      chunks.push(
        `diff --git a/${target.filePath} b/${target.filePath}\n` +
          `deleted file mode 100644\n` +
          `--- a/${target.filePath}\n` +
          "+++ /dev/null\n" +
          "@@\n" +
          `-<failed to read file for preview: ${msg}>\n`,
      );
    }
  }
  return chunks.join("\n");
}

export function createEditFileTool(
  confirmWrite: ToolConfirmationHandler,
): ToolDefinition<typeof editFileParameters> {
  return {
    name: "edit_file",
    description:
      "Apply search/replace edits to one or many files in one reviewed write. Uses exact match, or line-trim when only indentation differs. " +
      "Sentinels: empty searchBlock = whole-file replace (single edit only); '@head' / '@end' prepend or append. " +
      "Multiple edits run in order: prefer bottom-to-top and anchor searchBlocks on the original file to avoid offset drift. " +
      "Input must be { targets: [{ filePath, edits }, ...] }. User approves one unified diff for the whole batch.",
    parameters: editFileParameters,
    handler: async (input) => {
      const policy = getWorkspaceFsPolicy();
      const preparedTargets: {
        filePath: string;
        resolved: ResolvedFsPath;
        raw: string;
        newContent: string;
        editsCount: number;
      }[] = [];

      // Merge edits for a repeated filePath instead of rejecting the batch: models
      // routinely emit one target per edit site in the same file. Edits are concatenated
      // in arrival order and still applied sequentially by applyBlockEdits.
      const mergedTargets: {
        filePath: string;
        edits: { searchBlock: string; replaceBlock: string }[];
      }[] = [];
      const indexByPath = new Map<string, number>();
      for (const { filePath, edits } of input.targets) {
        const normalizedPath = filePath.trim();
        if (normalizedPath.length === 0) {
          return "filePath cannot be empty.";
        }
        const existingIdx = indexByPath.get(normalizedPath);
        if (existingIdx === undefined) {
          indexByPath.set(normalizedPath, mergedTargets.length);
          mergedTargets.push({ filePath: normalizedPath, edits: [...edits] });
        } else {
          mergedTargets[existingIdx]!.edits.push(...edits);
        }
      }

      for (const { filePath: normalizedPath, edits } of mergedTargets) {
        const resolved = await resolveToolFsPath(normalizedPath, "write");
        if (!resolved.ok) {
          return resolved.error;
        }

        const hasWholeFileReplace = edits.some((e) => e.searchBlock.trim() === "");
        if (hasWholeFileReplace && edits.length !== 1) {
          return `Invalid edits for ${normalizedPath}: empty searchBlock is only allowed when edits has exactly one entry (whole-file replace).`;
        }

        let raw: string;
        try {
          const stat = await policy.statResolved(resolved);
          if (stat.size > MAX_WRITE_BYTES) {
            return `File too large (${stat.size} bytes): ${normalizedPath}; max ${MAX_WRITE_BYTES} for edits.`;
          }
          raw = await policy.readResolved(resolved);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return `Failed to read file ${normalizedPath}: ${msg}`;
        }

        const editResult = applyBlockEdits(raw, edits);
        if (!editResult.ok) {
          return `Cannot apply edit for ${normalizedPath} at index ${editResult.failedIndex}: ${editResult.reason}`;
        }

        preparedTargets.push({
          filePath: resolved.displayPath,
          resolved,
          raw,
          newContent: editResult.text,
          editsCount: edits.length,
        });
      }

      const unifiedDiff = preparedTargets
        .map((target) => makePatch(target.filePath, target.raw, target.newContent))
        .join("\n");
      const isBatch = preparedTargets.length > 1;
      const decision = await confirmWrite({
        type: "fs_write",
        kind: "edit",
        filePath: isBatch ? `${preparedTargets.length} files` : preparedTargets[0]!.filePath,
        unifiedDiff,
        proposedContent: isBatch ? "" : preparedTargets[0]!.newContent,
        reviewCaption: isBatch ? `Batch edit across ${preparedTargets.length} files` : undefined,
        outsideWorkspace: preparedTargets.some((target) => target.resolved.outside),
        supportedActions: isBatch ? BATCH_REFACTOR_WRITE_ACTIONS : REFACTOR_WRITE_ACTIONS,
      });
      if (decision.action === "reject") {
        return "Write denied by user; files unchanged.";
      }
      if (decision.action === "retry") {
        return `User asked to retry with feedback: ${decision.feedback}`;
      }
      if (decision.action === "edit" && isBatch) {
        return "Host returned action=edit for batch mode, which is unsupported. Retry with accept/reject/retry.";
      }

      for (let i = 0; i < preparedTargets.length; i += 1) {
        const target = preparedTargets[i]!;
        const contentToWrite =
          decision.action === "edit" && i === 0 ? decision.modifiedContent : target.newContent;
        try {
          await policy.writeResolved(target.resolved, contentToWrite);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return `Failed to write file ${target.filePath}: ${msg}`;
        }
      }

      const totalEdits = preparedTargets.reduce((sum, item) => sum + item.editsCount, 0);
      if (isBatch) {
        return `Updated ${preparedTargets.length} files (${totalEdits} edit(s) total).`;
      }
      return `Updated ${preparedTargets[0]!.filePath} (${totalEdits} edit(s)).`;
    },
  };
}

export function createCreateFileTool(
  confirmWrite: ToolConfirmationHandler,
): ToolDefinition<typeof createFileParameters> {
  return {
    name: "create_file",
    description: `Create one or many new files with given UTF-8 content. Fails if any file already exists. Use ${AGENT_SCRATCH_DIR}/ for temporary scripts and intermediate files. User must approve the unified diff first.`,
    parameters: createFileParameters,
    handler: async (input) => {
      const policy = getWorkspaceFsPolicy();
      const targets = input.targets;
      const seenPaths = new Set<string>();

      const seenResolvedPaths = new Set<string>();
      const preparedTargets: {
        filePath: string;
        resolved: ResolvedFsPath;
        newN: string;
        patch: string;
      }[] = [];

      for (const { filePath, content } of targets) {
        const normalizedPath = filePath.trim();
        if (normalizedPath.length === 0) {
          return "filePath cannot be empty.";
        }
        if (seenPaths.has(normalizedPath)) {
          return `Duplicate filePath in batch: ${normalizedPath}`;
        }
        seenPaths.add(normalizedPath);

        const resolved = await resolveToolFsPath(normalizedPath, "write");
        if (!resolved.ok) {
          return resolved.error;
        }
        const resolvedKey =
          process.platform === "win32" ? resolved.abs.toLowerCase() : resolved.abs;
        if (seenResolvedPaths.has(resolvedKey)) {
          return `Duplicate filePath in batch: ${normalizedPath}`;
        }
        seenResolvedPaths.add(resolvedKey);

        const bytes = Buffer.byteLength(content, "utf8");
        if (bytes > MAX_WRITE_BYTES) {
          return `Content too large (${bytes} bytes) for ${normalizedPath}; max ${MAX_WRITE_BYTES}.`;
        }

        try {
          await policy.statResolved(resolved);
          return `Refused: ${normalizedPath} already exists. Use edit_file or delete manually.`;
        } catch (e: unknown) {
          const code =
            e && typeof e === "object" && "code" in e
              ? (e as NodeJS.ErrnoException).code
              : undefined;
          if (code !== "ENOENT") {
            const msg = e instanceof Error ? e.message : String(e);
            return `Cannot stat ${normalizedPath}: ${msg}`;
          }
        }

        const newN = normalizeNewlines(content);
        const patch = makePatch(resolved.displayPath, "", newN);
        preparedTargets.push({ filePath: resolved.displayPath, resolved, newN, patch });
      }

      const unifiedDiff = preparedTargets.map((t) => t.patch).join("\n");
      const isBatch = preparedTargets.length > 1;

      const decision = await confirmWrite({
        type: "fs_write",
        kind: "create",
        filePath: isBatch ? `${preparedTargets.length} files` : preparedTargets[0]!.filePath,
        unifiedDiff,
        proposedContent: isBatch ? "" : preparedTargets[0]!.newN,
        reviewCaption: isBatch ? `Batch create ${preparedTargets.length} files` : undefined,
        outsideWorkspace: preparedTargets.some((target) => target.resolved.outside),
        supportedActions: isBatch ? BATCH_REFACTOR_WRITE_ACTIONS : REFACTOR_WRITE_ACTIONS,
      });

      if (decision.action === "reject") {
        return "Write denied by user; files not created.";
      }
      if (decision.action === "retry") {
        return `User asked to retry with feedback: ${decision.feedback}`;
      }
      if (decision.action === "edit" && isBatch) {
        return "Host returned action=edit for batch mode, which is unsupported. Retry with accept/reject/retry.";
      }

      for (let i = 0; i < preparedTargets.length; i += 1) {
        const target = preparedTargets[i]!;
        const contentToWrite =
          decision.action === "edit" && i === 0 ? decision.modifiedContent : target.newN;
        try {
          const parentAbs = path.dirname(target.resolved.abs);
          const parentDisplayPath = path.dirname(target.resolved.displayPath);
          const parentResolved: ResolvedFsPath = {
            abs: parentAbs,
            rel: path.dirname(target.resolved.rel),
            displayPath: parentDisplayPath,
            outside: target.resolved.outside,
          };
          if (parentResolved.rel !== "." && parentResolved.displayPath !== ".") {
            await policy.mkdirResolved(parentResolved, { recursive: true });
          }
          await policy.writeNewResolved(target.resolved, contentToWrite);
        } catch (e: unknown) {
          if (getErrnoCode(e) === "EEXIST") {
            return `Refused: ${target.filePath} already exists. Use edit_file or delete manually.`;
          }
          const msg = e instanceof Error ? e.message : String(e);
          return `Failed to create file ${target.filePath}: ${msg}`;
        }
      }

      if (isBatch) {
        return `Created ${preparedTargets.length} files.`;
      }
      return `Created ${preparedTargets[0]!.filePath}.`;
    },
  };
}

export function createDeleteFileTool(
  confirmWrite: ToolConfirmationHandler,
): ToolDefinition<typeof deleteFileParameters> {
  return {
    name: "delete_file",
    description:
      "Batch-delete files or directories that are no longer needed. Warning: deleting paths still referenced elsewhere can break builds or runtime behavior.",
    parameters: deleteFileParameters,
    handler: async (input: DeleteTargetInput) => {
      const policy = getWorkspaceFsPolicy();
      const targetPaths = input.targetPaths;
      const seenPaths = new Set<string>();
      const seenResolvedPaths = new Set<string>();
      const existingTargets: ExistingDeleteTarget[] = [];
      const warnings: string[] = [];

      // Phase 1: validate inputs, resolve them inside the workspace jail, and collect
      // the targets that still exist. Missing targets are kept as non-fatal warnings
      // so repeated delete attempts stay idempotent.
      for (const targetPath of targetPaths) {
        const normalizedPath = targetPath.trim();
        if (normalizedPath.length === 0) {
          return "targetPaths entries cannot be empty.";
        }
        if (seenPaths.has(normalizedPath)) {
          return `Duplicate target path in batch: ${normalizedPath}`;
        }
        seenPaths.add(normalizedPath);

        const resolved = policy.tryResolve(normalizedPath);
        if (!resolved.ok) {
          return resolved.error;
        }
        if (resolved.rel === ".") {
          return "Refused: delete_file cannot remove the workspace root.";
        }
        if (seenResolvedPaths.has(resolved.rel)) {
          return `Duplicate target path in batch: ${normalizedPath}`;
        }
        seenResolvedPaths.add(resolved.rel);

        try {
          const stat = await policy.stat(resolved.rel);
          existingTargets.push({
            filePath: normalizedPath,
            rel: resolved.rel,
            isDirectory: stat.isDirectory(),
            size: stat.size,
          });
        } catch (e: unknown) {
          const code = getErrnoCode(e);
          if (code === "ENOENT") {
            warnings.push(`File already deleted: ${normalizedPath}`);
            continue;
          }
          const msg = e instanceof Error ? e.message : String(e);
          return `Failed to inspect target ${normalizedPath}: ${msg}`;
        }
      }

      if (existingTargets.length === 0) {
        return warnings.length > 0 ? warnings.join("\n") : "No deletable target found.";
      }

      // Phase 2: show the user one reviewed diff for the full batch before touching
      // disk. Delete does not support host-side edit, only accept/reject/retry.
      const unifiedDiff = await buildDeleteUnifiedDiff(policy, existingTargets);
      const isBatch = existingTargets.length > 1;
      const decision = await confirmWrite({
        type: "fs_write",
        kind: "delete",
        filePath: isBatch ? `${existingTargets.length} targets` : existingTargets[0]!.filePath,
        unifiedDiff,
        proposedContent: "",
        reviewCaption: isBatch
          ? `Batch delete across ${existingTargets.length} targets`
          : undefined,
        supportedActions: BATCH_REFACTOR_WRITE_ACTIONS,
      });
      if (decision.action === "reject") {
        return "Delete denied by user; files unchanged.";
      }
      if (decision.action === "retry") {
        return `User asked to retry with feedback: ${decision.feedback}`;
      }
      if (decision.action === "edit") {
        return "Host returned action=edit for delete_file, which is unsupported. Retry with accept/reject/retry.";
      }

      // Phase 3: perform the accepted deletes, then prune any now-empty parent
      // directories without crossing the workspace root. Both operations stay inside
      // WorkspaceFsPolicy so delete cannot bypass path guards.
      const deleted: string[] = [];
      const cleanupRemoved = new Set<string>();
      for (const target of existingTargets) {
        try {
          await policy.deleteEntry(target.rel);
          deleted.push(target.filePath);

          const parentRel = path.dirname(target.rel);
          const removedParents = await policy.pruneEmptyParentsInside(parentRel);
          for (const relPath of removedParents) {
            cleanupRemoved.add(relPath);
          }
        } catch (e: unknown) {
          const code = getErrnoCode(e);
          if (code === "ENOENT") {
            warnings.push(`File already deleted: ${target.filePath}`);
            continue;
          }
          const msg = e instanceof Error ? e.message : String(e);
          return `Failed to delete ${target.filePath}: ${msg}`;
        }
      }

      // Phase 4: format a compact result summary, including cleanup and any benign
      // race warnings from targets that disappeared before deletion.
      const lines: string[] = [];
      lines.push(`Deleted ${deleted.length} target(s).`);
      if (cleanupRemoved.size > 0) {
        const sortedDirs = [...cleanupRemoved].sort();
        lines.push(
          `Cleaned ${sortedDirs.length} empty parent director${sortedDirs.length === 1 ? "y" : "ies"}.`,
        );
      }
      if (warnings.length > 0) {
        lines.push(...warnings);
      }
      return lines.join("\n");
    },
  };
}
