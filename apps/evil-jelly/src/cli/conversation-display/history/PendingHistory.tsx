import { Box, Text } from "ink";
import { useMemo } from "react";
import { type PromptInput, promptInputPlainText } from "../../../shared/model/prompt/promptInput";
import { HistoryItem } from "./HistoryItem";
import type { Turn } from "./model";

/** The input owns its preview budget; later notices cannot crop its beginning away. */
export function PendingHistory({
  turns,
  preparingInput,
  columns,
  maxRows,
}: {
  turns: Turn[];
  preparingInput?: PromptInput | null;
  columns: number;
  maxRows: number;
}) {
  // A view-only turn, never appended to history or given ownership of draft attachments.
  // Keep the same preview mounted through handover so unchanged text need not be laid out twice.
  const acknowledgement = useMemo<Turn | null>(() => {
    if (!preparingInput) return null;
    return {
      id: "preparing-input",
      type: "user",
      content: promptInputPlainText({
        ...preparingInput,
        // Do not expand or count a potentially enormous paste just to acknowledge it.
        document: preparingInput.document.map((node) =>
          node.type === "token" && node.kind === "paste"
            ? { type: "text" as const, text: "[Paste]" }
            : node,
        ),
      }),
    };
  }, [preparingInput]);
  const input = turns[0] ?? acknowledgement;
  if (!input) return null;
  const budget = Math.max(6, maxRows);
  const notices = turns.slice(1);
  const capacity = Math.min(2, Math.max(0, budget - 6));
  const visible = capacity > 0 ? notices.slice(-capacity) : [];
  const hidden = notices.length - visible.length;
  const noticeRows = visible.length + (hidden > 0 ? 1 : 0);

  return (
    <Box flexDirection="column" width={columns}>
      <Text color="gray" wrap="truncate-end">
        {turns.length > 0 ? "Pending input" : "Pending input · preparing…"}
      </Text>
      <HistoryItem turn={input} columns={columns} userMaxRows={budget - noticeRows - 2} />
      {hidden > 0 ? (
        <Text dimColor wrap="truncate-end">
          … {hidden} earlier notices
        </Text>
      ) : null}
      {visible.map((turn) => (
        <Text key={turn.id} dimColor wrap="truncate-end">
          {"content" in turn ? turn.content.replace(/\s+/g, " ").trim() : "Additional activity"}
        </Text>
      ))}
    </Box>
  );
}
