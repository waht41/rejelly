import { Box, Text } from "ink";
import { useMemo } from "react";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { normalizeNewlines } from "../../../shared/foundation/string";
import type { UserMessagePresentation } from "../../../shared/host/presentationBindings";

/** Expand before measuring: raw tabs move the terminal cursor outside Ink's cell grid. */
function expandUserMessageTabs(text: string): string {
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
  const preview = useMemo(() => {
    const pending = maxRows !== undefined;
    const text = pending ? (presentation?.summary ?? content) : content;
    const rows = wrapAnsi(`❯ ${expandUserMessageTabs(normalizeNewlines(text))}`, width, {
      hard: true,
      trim: false,
    }).split("\n");
    const attachments = pending ? attachmentSummary(presentation) : "";
    const bodyBudget = budget - (attachments ? 1 : 0);
    if (rows.length <= bodyBudget) {
      return { head: rows, tail: [], omittedRows: 0, attachments };
    }

    // Reserve one prominent separator. Blank rows touching the cut do not deserve scarce
    // preview space; trimming them here never changes the original message in history.
    const shown = bodyBudget - 1;
    let headEnd = Math.ceil(shown / 2);
    while (headEnd > 1 && rows[headEnd - 1]?.trim() === "") headEnd--;
    let tailEnd = rows.length;
    while (tailEnd > headEnd && rows[tailEnd - 1]?.trim() === "") tailEnd--;
    let tailStart = Math.max(headEnd, tailEnd - Math.floor(shown / 2));
    while (tailStart < tailEnd && rows[tailStart]?.trim() === "") tailStart++;
    const head = rows.slice(0, headEnd);
    const tail = rows.slice(tailStart, tailEnd);
    return { head, tail, omittedRows: rows.length - head.length - tail.length, attachments };
  }, [content, presentation, width, budget, maxRows]);

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
      {preview.omittedRows > 0 ? (
        <Text bold color="gray" wrap="truncate-end">
          {`─ ${preview.omittedRows} rows folded ${"─".repeat(Math.max(1, width - stringWidth(`─ ${preview.omittedRows} rows folded `)))}`}
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
