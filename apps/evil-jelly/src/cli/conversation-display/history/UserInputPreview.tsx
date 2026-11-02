import { Box, Text } from "ink";
import { useMemo } from "react";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { normalizeNewlines } from "../../../shared/foundation/string";
import type { UserMessagePresentation } from "../../../shared/host/presentationBindings";

/** Expand before measuring: raw tabs move the terminal cursor outside Ink's cell grid. */
function expandUserMessageTabs(text: string): string {
  if (!text.includes("\t")) return text;
  return text
    .split("\n")
    .map((line) => {
      let column = 0;
      return line
        .split("\t")
        .map((segment, index) => {
          const padding = index === 0 ? "" : " ".repeat(4 - (column % 4));
          column += padding.length + stringWidth(segment);
          return padding + segment;
        })
        .join("");
    })
    .join("\n");
}

function attachmentSummary(presentation: UserMessagePresentation | undefined): string {
  const attachments = presentation?.attachments ?? [];
  if (attachments.length === 0) return "";
  const failures = attachments.filter((attachment) => attachment.status === "error");
  return failures.length > 0
    ? `Failed: ${failures.length}/${attachments.length} attachments · ${failures.map((item) => item.label).join(", ")}`
    : `Attachments: ${attachments.length} · ${attachments.map((item) => item.label).join(", ")}`;
}

export function UserInputPreview({
  content,
  presentation,
  columns,
  maxRows,
}: {
  content: string;
  presentation?: UserMessagePresentation;
  columns: number;
  maxRows?: number;
}) {
  const width = Math.max(1, columns - 2);
  // Only the withdrawable pending view supplies a row budget. Static history must render
  // the original message, including paste bodies, rather than freezing a transient preview.
  const budget = Math.max(3, maxRows ?? Infinity);
  const pending = maxRows !== undefined;
  const text = pending ? (presentation?.summary ?? content) : content;
  const attachments = pending ? attachmentSummary(presentation) : "";
  const preview = useMemo(() => {
    const bodyBudget = budget - (attachments ? 1 : 0);
    const normalized = normalizeNewlines(text);
    // Limit expensive cell-width/grapheme layout BEFORE wrapping. Hidden middle content
    // needs no terminal rows; an exact folded-row count would defeat that bound.
    const windowChars = Math.max(64, width * bodyBudget);
    const source = pending ? normalized.trimEnd() : normalized;
    const bounded = pending && source.length > windowChars * 2;
    let start = source;
    let end = source;
    if (bounded) {
      start = source.slice(0, windowChars);
      end = source.slice(-windowChars);
      // Prefer complete logical lines, but still preview both ends of a huge single line.
      const headBreak = start.lastIndexOf("\n");
      const tailBreak = end.indexOf("\n");
      if (headBreak >= 0) start = start.slice(0, headBreak);
      if (tailBreak >= 0) end = end.slice(tailBreak + 1);
      start = start.replace(/[\uD800-\uDBFF]$/, "");
      end = end.replace(/^[\uDC00-\uDFFF]/, "");
    }
    const wrap = (value: string) => wrapAnsi(value, width, { hard: true, trim: false }).split("\n");
    const rows = wrap(`❯ ${expandUserMessageTabs(start)}`);
    if (!bounded && rows.length <= bodyBudget) {
      return { head: rows, tail: [], foldLabel: "", attachments };
    }

    // Reserve one separator. Blank rows touching the cut do not deserve scarce preview
    // space; trimming them here never changes the original message in history.
    const shown = bodyBudget - 1;
    let headEnd = Math.min(rows.length, Math.ceil(shown / 2));
    while (headEnd > 1 && rows[headEnd - 1]?.trim() === "") headEnd--;
    const endingRows = bounded ? wrap(expandUserMessageTabs(end)) : rows;
    let tailEnd = endingRows.length;
    const tailFloor = bounded ? 0 : headEnd;
    while (tailEnd > tailFloor && endingRows[tailEnd - 1]?.trim() === "") tailEnd--;
    let tailStart = Math.max(tailFloor, tailEnd - Math.floor(shown / 2));
    while (tailStart < tailEnd && endingRows[tailStart]?.trim() === "") tailStart++;
    const head = rows.slice(0, headEnd);
    const tail = endingRows.slice(tailStart, tailEnd);
    const foldLabel = bounded
      ? "content folded"
      : `${rows.length - head.length - tail.length} rows folded`;
    return { head, tail, foldLabel, attachments };
  }, [text, attachments, width, budget, pending]);

  return (
    <Box
      flexDirection="column"
      width={columns}
      paddingX={1}
      marginBottom={1}
      backgroundColor="#333"
    >
      {preview.head.map((row, index) => (
        <Text key={`head-${index}`} bold color="whiteBright" wrap="truncate-end">
          {row || " "}
        </Text>
      ))}
      {preview.foldLabel ? (
        <Text bold color="gray" wrap="truncate-end">
          {`─ ${preview.foldLabel} ${"─".repeat(Math.max(1, width - stringWidth(`─ ${preview.foldLabel} `)))}`}
        </Text>
      ) : null}
      {preview.tail.map((row, index) => (
        <Text key={`tail-${index}`} bold color="whiteBright" wrap="truncate-end">
          {row || " "}
        </Text>
      ))}
      {preview.attachments ? (
        <Text
          color={
            presentation?.attachments.some((item) => item.status === "error") ? "yellow" : undefined
          }
          dimColor={!presentation?.attachments.some((item) => item.status === "error")}
          wrap="truncate-end"
        >
          {preview.attachments}
        </Text>
      ) : null}
    </Box>
  );
}
