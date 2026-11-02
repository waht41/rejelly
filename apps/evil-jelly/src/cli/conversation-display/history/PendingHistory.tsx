import { Box, Text } from "ink";
import { HistoryItem } from "./HistoryItem";
import type { Turn } from "./model";

/** The input owns its preview budget; later notices cannot crop its beginning away. */
export function PendingHistory({
  turns,
  columns,
  maxRows,
}: {
  turns: Turn[];
  columns: number;
  maxRows: number;
}) {
  const input = turns[0];
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
        Pending input
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
