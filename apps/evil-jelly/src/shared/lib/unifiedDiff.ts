import {
  FILE_HEADERS_ONLY,
  formatPatch,
  type StructuredPatch,
  type StructuredPatchHunk,
  structuredPatch,
} from "diff";

/**
 * Unified diff for LLM review and human inspection.
 *
 * Uses Myers diff from `diff` so large Markdown files do not pay the quadratic
 * memory cost of the previous hand-written LCS implementation.
 */

/** Unchanged lines kept around each edit (Git default is 3; higher value stabilizes LLM anchoring). */
const DIFF_CONTEXT_LINES = 8;

function countLogicalLines(text: string): number {
  if (text === "") {
    return 0;
  }

  const lineCount = text.split(/\r?\n/).length;
  return text.endsWith("\n") ? lineCount - 1 : lineCount;
}

function detectBoundaryMarkers(
  hunk: StructuredPatchHunk,
  oldLastLineIndex: number,
  newLastLineIndex: number,
): { bof: boolean; eof: boolean } {
  let bof = false;
  let eof = false;
  let oldLineIndex = Math.max(0, hunk.oldStart - 1);
  let newLineIndex = Math.max(0, hunk.newStart - 1);

  for (const line of hunk.lines) {
    if (line.startsWith("\\")) {
      continue;
    }

    const op = line[0];
    if (op === " ") {
      oldLineIndex++;
      newLineIndex++;
      continue;
    }

    if (op === "-") {
      if (oldLineIndex === 0) {
        bof = true;
      }
      if (oldLineIndex === oldLastLineIndex) {
        eof = true;
      }
      oldLineIndex++;
      continue;
    }

    if (op === "+") {
      if (newLineIndex === 0) {
        bof = true;
      }
      if (newLineIndex === newLastLineIndex) {
        eof = true;
      }
      newLineIndex++;
    }
  }

  return { bof, eof };
}

function injectBoundaryMarkers(
  patch: StructuredPatch,
  oldStr: string,
  newStr: string,
): StructuredPatch {
  const oldLastLineIndex = countLogicalLines(oldStr) - 1;
  const newLastLineIndex = countLogicalLines(newStr) - 1;

  patch.hunks = patch.hunks.map((hunk) => {
    const { bof, eof } = detectBoundaryMarkers(hunk, oldLastLineIndex, newLastLineIndex);
    const lines = [...hunk.lines];

    if (bof) {
      lines.unshift("[BOF]");
    }

    if (eof) {
      lines.push("[EOF]");
    }

    return {
      ...hunk,
      lines,
    };
  });

  return patch;
}

export function createTwoFilesPatch(filePath: string, oldStr: string, newStr: string): string {
  if (oldStr === newStr) {
    return "";
  }

  const patch = structuredPatch(filePath, filePath, oldStr, newStr, "", "", {
    context: DIFF_CONTEXT_LINES,
  });

  const withMarkers = injectBoundaryMarkers(patch, oldStr, newStr);
  const formatted = formatPatch(withMarkers, FILE_HEADERS_ONLY);

  return formatted.endsWith("\n") ? formatted.slice(0, -1) : formatted;
}
