import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

export type DiffLineKind = "file" | "addition" | "deletion" | "hunk" | "meta" | "fold" | "context";

export type ProjectedDiffLine = {
  text: string;
  kind: DiffLineKind;
  startsFile?: boolean;
  oldLine?: number;
  newLine?: number;
  marker?: " " | "+" | "-";
};

export type DisplayDiffLine = {
  text: string;
  content: string;
  gutter: string;
  marker: string;
  kind: DiffLineKind;
  startsFile?: boolean;
  continuation?: boolean;
};

export type DiffSummary = {
  additions: number;
  deletions: number;
  files: number;
};

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function cleanDiffPath(path: string): string {
  const value = path.trim().split("\t", 1)[0] ?? "";
  let unquoted = value;

  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      unquoted = JSON.parse(value) as string;
    } catch {
      unquoted = value.slice(1, -1);
    }
  }

  return unquoted.replace(/\\{2,}/g, "\\");
}

export function projectUnifiedDiff(diffText: string): ProjectedDiffLine[] {
  const rawLines = diffText.split("\n");
  const projected: ProjectedDiffLine[] = [];
  let oldLine: number | undefined;
  let newLine: number | undefined;

  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index] ?? "";
    const next = rawLines[index + 1];
    if (line.startsWith("--- ") && next?.startsWith("+++ ")) {
      const oldPath = cleanDiffPath(line.slice(4));
      const newPath = cleanDiffPath(next.slice(4));
      projected.push({
        text: newPath === "/dev/null" ? oldPath : newPath,
        kind: "file",
        startsFile: projected.some((item) => item.kind === "file"),
      });
      oldLine = undefined;
      newLine = undefined;
      index += 1;
      continue;
    }

    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      projected.push({ text: line, kind: "hunk" });
      continue;
    }
    if (line.startsWith("@@")) {
      oldLine = undefined;
      newLine = undefined;
      projected.push({ text: line, kind: "hunk" });
      continue;
    }
    if (line.startsWith("diff --git ") || /^={3,}$/.test(line) || /^(new|deleted) /.test(line)) {
      projected.push({ text: line, kind: "meta" });
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      projected.push({ text: line.slice(1), kind: "addition", newLine, marker: "+" });
      if (newLine !== undefined) newLine += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      projected.push({ text: line.slice(1), kind: "deletion", oldLine, marker: "-" });
      if (oldLine !== undefined) oldLine += 1;
      continue;
    }
    if (line.startsWith(" ") && oldLine !== undefined && newLine !== undefined) {
      projected.push({
        text: line.slice(1),
        kind: "context",
        oldLine,
        newLine,
        marker: " ",
      });
      oldLine += 1;
      newLine += 1;
      continue;
    }
    if (line === "[BOF]" || line === "[EOF]" || line.startsWith("\\ No newline")) {
      projected.push({ text: line, kind: "meta" });
      continue;
    }
    projected.push({ text: line || " ", kind: "context" });
  }

  return projected;
}

export function summarizeUnifiedDiff(diffText: string): DiffSummary {
  const projected = projectUnifiedDiff(diffText);
  return {
    additions: projected.filter((line) => line.kind === "addition").length,
    deletions: projected.filter((line) => line.kind === "deletion").length,
    files: projected.filter((line) => line.kind === "file").length,
  };
}

/** Keep nearby context while folding the extra anchoring lines carried by the underlying patch. */
export function collapseDiffContext(
  lines: readonly ProjectedDiffLine[],
  radius = 3,
): ProjectedDiffLine[] {
  const result: ProjectedDiffLine[] = [];

  for (let index = 0; index < lines.length; ) {
    if (lines[index]?.kind !== "context" || lines[index]?.oldLine === undefined) {
      result.push(lines[index]!);
      index += 1;
      continue;
    }

    const start = index;
    while (lines[index]?.kind === "context" && lines[index]?.oldLine !== undefined) {
      index += 1;
    }
    const run = lines.slice(start, index);
    const previous = lines[start - 1];
    const next = lines[index];
    const keepStart = previous?.kind === "addition" || previous?.kind === "deletion" ? radius : 0;
    const keepEnd = next?.kind === "addition" || next?.kind === "deletion" ? radius : 0;
    const omitted = run.length - keepStart - keepEnd;

    if (omitted <= 0) {
      result.push(...run);
      continue;
    }
    result.push(...run.slice(0, keepStart));
    result.push({ text: `⋯ ${omitted} unchanged lines`, kind: "fold" });
    if (keepEnd > 0) {
      result.push(...run.slice(-keepEnd));
    }
  }

  return result;
}

function numberWidth(lines: readonly ProjectedDiffLine[]): number {
  const maximum = lines.reduce(
    (value, line) => Math.max(value, line.oldLine ?? 0, line.newLine ?? 0),
    0,
  );
  return Math.max(1, String(maximum).length);
}

function wrapContent(text: string, width: number): string[] {
  if (stringWidth(text) <= width) return [text];
  return wrapAnsi(text, width, { trim: false, hard: true }).split("\n");
}

/** Format and wrap projected rows using one terminal-cell model for every diff view. */
export function layoutDiffLines(
  lines: readonly ProjectedDiffLine[],
  columns: number,
): DisplayDiffLine[] {
  const width = Math.max(1, columns);
  const digits = numberWidth(lines);
  const numberedGutterWidth = digits * 2 + 2;

  return lines.flatMap((line) => {
    const numbered = line.oldLine !== undefined || line.newLine !== undefined;
    const gutter = numbered
      ? `${line.oldLine?.toString().padStart(digits) ?? " ".repeat(digits)} ${
          line.newLine?.toString().padStart(digits) ?? " ".repeat(digits)
        } `
      : "";
    const marker = line.marker === undefined ? "" : `${line.marker} `;
    const reserved = stringWidth(gutter) + stringWidth(marker);
    const continuationReserve = !numbered && stringWidth(line.text) > width ? 2 : 0;
    const contentWidth = Math.max(1, width - reserved - continuationReserve);
    const wrapped = wrapContent(line.text, contentWidth);

    return wrapped.map((content, index) => {
      const continuation = index > 0;
      const rowGutter = continuation ? " ".repeat(numbered ? numberedGutterWidth : 0) : gutter;
      const rowMarker = continuation ? (width - rowGutter.length >= 2 ? "↳ " : "") : marker;
      return {
        text: `${rowGutter}${rowMarker}${content}`,
        content,
        gutter: rowGutter,
        marker: rowMarker,
        kind: line.kind,
        startsFile: index === 0 ? line.startsFile : false,
        continuation,
      };
    });
  });
}

export function projectDiffForDisplay(diffText: string, columns: number): DisplayDiffLine[] {
  return layoutDiffLines(collapseDiffContext(projectUnifiedDiff(diffText)), columns);
}
