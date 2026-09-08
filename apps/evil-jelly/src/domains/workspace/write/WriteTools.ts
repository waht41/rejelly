/**
 * edit_file / create_file with host-gated writes (no silent disk mutation).
 */

import path from "node:path";
import type { ToolDefinition } from "@rejelly/core";
import { z } from "zod";
import { getErrnoCode } from "../../../shared/foundation/errno";
import { normalizeNewlines } from "../../../shared/foundation/string";
import { AGENT_SCRATCH_DIR } from "../../../shared/fs-policy/workspace-context";
import {
  getWorkspaceFiles,
  type ResolvedFsPath,
  type WorkspaceFiles,
} from "../../../shared/fs-policy/workspace-files";
import type {
  ToolConfirmationHandler,
  WriteActionType,
} from "../../../shared/host/toolConfirmationBindings";
import { resolveFileToolPath } from "../file-access/resolveFileToolPath";
import { MAX_READ_BYTES_PER_CALL } from "../read/FileSystemTools";
import { applyBlockEdits, type SearchBlock } from "./blockReplace";
import { createTwoFilesPatch } from "./unifiedDiff";

const MAX_WRITE_BYTES = MAX_READ_BYTES_PER_CALL;

/** Refactor tools expose full host actions (binary-only callers omit or narrow supportedActions). */
const REFACTOR_WRITE_ACTIONS: WriteActionType[] = ["accept", "reject", "edit", "retry"];
const BATCH_REFACTOR_WRITE_ACTIONS: WriteActionType[] = ["accept", "reject", "retry"];

export type WriteToolObservationOptions = {
  recordAppliedDiff?: (detail: { text: string; caption?: string }) => void;
};

function recordAppliedPatches(
  options: WriteToolObservationOptions,
  patches: string[],
  caption?: string,
): void {
  const text = patches.filter((patch) => patch.trim().length > 0).join("\n");
  if (text.length > 0) {
    options.recordAppliedDiff?.({ text, ...(caption ? { caption } : {}) });
  }
}

const nonBlankBoundedAnchorSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, "Bounded anchors cannot be blank.");

const boundedSearchBlockSchema = z
  .object({
    kind: z.literal("bounded"),
    startBlock: nonBlankBoundedAnchorSchema
      .refine((value) => value.trim() !== "@end", "startBlock cannot use @end; use @head.")
      .describe(
        "Exact or line-trim opening anchor included in the replaced range, or @head for the file start.",
      ),
    endBlock: nonBlankBoundedAnchorSchema
      .refine((value) => value.trim() !== "@head", "endBlock cannot use @head; use @end.")
      .describe(
        "Exact or line-trim closing anchor included in the replaced range, or @end for the file end.",
      ),
  })
  .strict()
  .describe(
    "Replace one inclusive range. Concrete anchors must each match exactly one region and the end must not precede the start; startBlock may be @head and endBlock may be @end.",
  );

const editBlockSchema = z.object({
  searchBlock: z
    .union([z.string(), boundedSearchBlockSchema])
    .describe(
      "A string matches contiguous old code (exact first, then line-trim), with empty/@head/@end sentinels. " +
        "For a large range, use { kind: 'bounded', startBlock, endBlock }; concrete anchors are inclusive and independently unique, while @head/@end select positional file boundaries.",
    ),
  replaceBlock: z.string().describe("New code to substitute for the matched region."),
});

const singleFileEditSchema = z.object({
  filePath: z.string().describe("Path to edit."),
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
    .describe("File or directory paths to delete in one batch."),
});

type DeleteTargetInput = z.infer<typeof deleteFileParameters>;

function makePatch(filePath: string, oldStr: string, newStr: string): string {
  const oldN = normalizeNewlines(oldStr);
  const newN = normalizeNewlines(newStr);
  return createTwoFilesPatch(filePath, oldN, newN);
}

type ExistingDeleteTarget = {
  filePath: string;
  resolved: ResolvedFsPath;
  isDirectory: boolean;
  size: number;
};

async function prepareDeleteTargets(
  policy: WorkspaceFiles,
  targets: ExistingDeleteTarget[],
): Promise<Array<{ target: ExistingDeleteTarget; patch: string }>> {
  const prepared: Array<{ target: ExistingDeleteTarget; patch: string }> = [];
  for (const target of targets) {
    if (target.isDirectory) {
      prepared.push({
        target,
        patch:
          `diff --git a/${target.filePath} b/${target.filePath}\n` +
          `deleted directory mode 040000\n` +
          `--- ${target.filePath}\n` +
          "+++ /dev/null\n",
      });
      continue;
    }

    if (target.size > MAX_WRITE_BYTES) {
      prepared.push({
        target,
        patch:
          `diff --git a/${target.filePath} b/${target.filePath}\n` +
          `deleted file mode 100644\n` +
          `--- ${target.filePath}\n` +
          "+++ /dev/null\n" +
          "@@\n" +
          `-<content omitted: ${target.size} bytes exceeds ${MAX_WRITE_BYTES} preview limit>\n`,
      });
      continue;
    }

    try {
      const raw = await policy.readResolved(target.resolved);
      prepared.push({ target, patch: makePatch(target.filePath, raw, "") });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      prepared.push({
        target,
        patch:
          `diff --git a/${target.filePath} b/${target.filePath}\n` +
          `deleted file mode 100644\n` +
          `--- ${target.filePath}\n` +
          "+++ /dev/null\n" +
          "@@\n" +
          `-<failed to read file for preview: ${msg}>\n`,
      });
    }
  }
  return prepared;
}

type PreparedEditTarget = {
  filePath: string;
  resolved: ResolvedFsPath;
  raw: string;
  newContent: string;
  editsCount: number;
};

type EditTargetFailure = {
  filePath: string;
  problems: Array<{ editIndex?: number; searchBlock?: SearchBlock; reason: string }>;
};

/** Identify a failed block without echoing an arbitrarily large tool argument back to the model. */
function summarizeTextBlock(block: string): string {
  const normalized = normalizeNewlines(block);
  const nonBlankLines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const first = nonBlankLines[0] ?? "";
  const last = nonBlankLines.at(-1) ?? "";
  const lineSuffix = nonBlankLines.length > 1 ? ` (${nonBlankLines.length} lines)` : "";
  const summary = nonBlankLines.length > 1 ? `${first} … ${last}${lineSuffix}` : first;
  const maxLength = 240;
  const bounded =
    summary.length <= maxLength
      ? summary
      : `${summary.slice(0, 160)} … ${summary.slice(-(maxLength - 163))}`;
  return JSON.stringify(bounded);
}

/** Identify a failed matcher without echoing arbitrarily large tool arguments back to the model. */
function summarizeSearchBlock(searchBlock: SearchBlock): string {
  if (typeof searchBlock === "string") {
    return summarizeTextBlock(searchBlock);
  }
  return (
    `{ kind: "bounded", startBlock: ${summarizeTextBlock(searchBlock.startBlock)}, ` +
    `endBlock: ${summarizeTextBlock(searchBlock.endBlock)} }`
  );
}

function appendEditFailures(lines: string[], failures: EditTargetFailure[]): void {
  lines.push(`Not applied files (${failures.length}):`);
  for (const failure of failures) {
    lines.push(`- ${failure.filePath}`);
    for (const problem of failure.problems) {
      const prefix = problem.editIndex === undefined ? "file" : `edit[${problem.editIndex}]`;
      lines.push(`  - ${prefix}`);
      if (problem.searchBlock !== undefined) {
        lines.push(`    searchBlock: ${summarizeSearchBlock(problem.searchBlock)}`);
      }
      lines.push(`    reason: ${problem.reason.replace(/\r?\n/g, "\n    ")}`);
    }
  }
}

function formatEditFailures(failures: EditTargetFailure[]): string {
  const lines = ["No files updated."];
  appendEditFailures(lines, failures);
  return lines.join("\n");
}

function formatPartialEditResult(
  prepared: PreparedEditTarget[],
  totalEdits: number,
  failures: EditTargetFailure[],
): string {
  const lines = [
    `Updated ${prepared.length} file(s) (${totalEdits} edit(s) total).`,
    `Applied files (${prepared.length}):`,
    ...prepared.map((target) => `- ${target.filePath} (${target.editsCount} edit(s))`),
  ];
  appendEditFailures(lines, failures);
  return lines.join("\n");
}

export function createEditFileTool(
  confirmWrite: ToolConfirmationHandler,
  observation: WriteToolObservationOptions = {},
): ToolDefinition<typeof editFileParameters> {
  return {
    name: "edit_file",
    description:
      "Apply search/replace edits to one or many files in one reviewed write. A string searchBlock uses exact match, or line-trim when only indentation differs; " +
      "a bounded matcher replaces the inclusive range between independently unique anchors, with @head/@end available as positional file boundaries. " +
      "Sentinels: empty string searchBlock = whole-file replace (single edit only); '@head' / '@end' prepend or append. " +
      "Multiple edits run in order: prefer bottom-to-top and anchor searchBlocks on the original file to avoid offset drift. " +
      "Every target is validated before writing. Files with any invalid edit are left unchanged and reported with all block failures; " +
      "conflict-free files continue to one unified-diff approval. Input must be { targets: [{ filePath, edits }, ...] }.",
    parameters: editFileParameters,
    handler: async (input) => {
      const policy = getWorkspaceFiles();
      const preparedTargets: PreparedEditTarget[] = [];
      const failedTargets: EditTargetFailure[] = [];

      // Merge edits for a repeated filePath instead of rejecting the batch: models
      // routinely emit one target per edit site in the same file. Edits are concatenated
      // in arrival order and still applied sequentially by applyBlockEdits.
      const mergedTargets: {
        filePath: string;
        edits: { searchBlock: SearchBlock; replaceBlock: string }[];
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
        const resolved = await resolveFileToolPath(normalizedPath, { kind: "write" });
        if (!resolved.ok) {
          failedTargets.push({ filePath: normalizedPath, problems: [{ reason: resolved.error }] });
          continue;
        }

        const hasWholeFileReplace = edits.some(
          (edit) => typeof edit.searchBlock === "string" && edit.searchBlock.trim() === "",
        );
        if (hasWholeFileReplace && edits.length !== 1) {
          failedTargets.push({
            filePath: normalizedPath,
            problems: [
              {
                reason:
                  "empty searchBlock is only allowed when edits has exactly one entry (whole-file replace).",
              },
            ],
          });
          continue;
        }

        let raw: string;
        try {
          const stat = await policy.statResolved(resolved);
          if (stat.size > MAX_WRITE_BYTES) {
            failedTargets.push({
              filePath: normalizedPath,
              problems: [
                {
                  reason: `File too large (${stat.size} bytes); max ${MAX_WRITE_BYTES} for edits.`,
                },
              ],
            });
            continue;
          }
          raw = await policy.readResolved(resolved);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          failedTargets.push({
            filePath: normalizedPath,
            problems: [{ reason: `Failed to read file: ${msg}` }],
          });
          continue;
        }

        const editResult = applyBlockEdits(raw, edits);
        if (!editResult.ok) {
          failedTargets.push({
            filePath: normalizedPath,
            problems: editResult.failures.map(({ failedIndex, reason }) => ({
              editIndex: failedIndex,
              ...(edits[failedIndex] !== undefined
                ? { searchBlock: edits[failedIndex].searchBlock }
                : {}),
              reason,
            })),
          });
          continue;
        }

        preparedTargets.push({
          filePath: resolved.displayPath,
          resolved,
          raw,
          newContent: editResult.text,
          editsCount: edits.length,
        });
      }

      if (preparedTargets.length === 0) {
        return formatEditFailures(failedTargets);
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

      const appliedPatches: string[] = [];
      for (let i = 0; i < preparedTargets.length; i += 1) {
        const target = preparedTargets[i]!;
        const contentToWrite =
          decision.action === "edit" && i === 0 ? decision.modifiedContent : target.newContent;
        try {
          await policy.writeResolved(target.resolved, contentToWrite);
          appliedPatches.push(makePatch(target.filePath, target.raw, contentToWrite));
          recordAppliedPatches(
            observation,
            appliedPatches,
            isBatch
              ? `Applied edit across ${appliedPatches.length} of ${preparedTargets.length} files`
              : undefined,
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return `Failed to write file ${target.filePath}: ${msg}`;
        }
      }

      const totalEdits = preparedTargets.reduce((sum, item) => sum + item.editsCount, 0);
      if (failedTargets.length > 0) {
        return formatPartialEditResult(preparedTargets, totalEdits, failedTargets);
      }
      if (isBatch) {
        return `Updated ${preparedTargets.length} files (${totalEdits} edit(s) total).`;
      }
      return `Updated ${preparedTargets[0]!.filePath} (${totalEdits} edit(s)).`;
    },
  };
}

export function createCreateFileTool(
  confirmWrite: ToolConfirmationHandler,
  observation: WriteToolObservationOptions = {},
): ToolDefinition<typeof createFileParameters> {
  return {
    name: "create_file",
    description: `Create one or many new files with given UTF-8 content. Fails if any file already exists. Use ${AGENT_SCRATCH_DIR}/ for temporary scripts and intermediate files. User must approve the unified diff first.`,
    parameters: createFileParameters,
    handler: async (input) => {
      const policy = getWorkspaceFiles();
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

        const resolved = await resolveFileToolPath(normalizedPath, { kind: "write" });
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

      const appliedPatches: string[] = [];
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
          appliedPatches.push(makePatch(target.filePath, "", contentToWrite));
          recordAppliedPatches(
            observation,
            appliedPatches,
            isBatch
              ? `Applied create across ${appliedPatches.length} of ${preparedTargets.length} files`
              : undefined,
          );
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
  observation: WriteToolObservationOptions = {},
): ToolDefinition<typeof deleteFileParameters> {
  return {
    name: "delete_file",
    description:
      "Batch-delete files or directories that are no longer needed. Warning: deleting paths still referenced elsewhere can break builds or runtime behavior.",
    parameters: deleteFileParameters,
    handler: async (input: DeleteTargetInput) => {
      const policy = getWorkspaceFiles();
      const targetPaths = input.targetPaths;
      const seenPaths = new Set<string>();
      const seenResolvedPaths = new Set<string>();
      const existingTargets: ExistingDeleteTarget[] = [];
      const warnings: string[] = [];

      // Phase 1: validate inputs, resolve workspace paths or approved external paths, and
      // collect the targets that still exist. Missing targets are kept as non-fatal warnings
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

        const resolved = await resolveFileToolPath(normalizedPath, { kind: "write" });
        if (!resolved.ok) {
          return resolved.error;
        }
        if (resolved.rel === ".") {
          return "Refused: delete_file cannot remove the workspace root.";
        }
        const resolvedKey =
          process.platform === "win32" ? resolved.abs.toLowerCase() : resolved.abs;
        if (seenResolvedPaths.has(resolvedKey)) {
          return `Duplicate target path in batch: ${normalizedPath}`;
        }
        seenResolvedPaths.add(resolvedKey);

        try {
          const stat = await policy.statResolved(resolved);
          existingTargets.push({
            filePath: normalizedPath,
            resolved,
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
      const preparedTargets = await prepareDeleteTargets(policy, existingTargets);
      const unifiedDiff = preparedTargets.map(({ patch }) => patch).join("\n");
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

      // Phase 3: perform the accepted deletes. For workspace targets, prune now-empty parents
      // without crossing the workspace root; outside targets deliberately keep their parents.
      const deleted: string[] = [];
      const appliedPatches: string[] = [];
      const cleanupRemoved = new Set<string>();
      for (const { target, patch } of preparedTargets) {
        try {
          await policy.deleteResolved(target.resolved);
          deleted.push(target.filePath);
          appliedPatches.push(patch);
          recordAppliedPatches(
            observation,
            appliedPatches,
            isBatch
              ? `Applied delete across ${appliedPatches.length} of ${preparedTargets.length} targets`
              : undefined,
          );

          if (!target.resolved.outside) {
            const parentRel = path.dirname(target.resolved.rel);
            const removedParents = await policy.pruneEmptyParentsInside(parentRel);
            for (const relPath of removedParents) {
              cleanupRemoved.add(relPath);
            }
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
