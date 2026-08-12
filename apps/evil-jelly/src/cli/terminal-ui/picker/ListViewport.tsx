import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { getVisibleWindow } from "./listNavigation";

export interface ListItemRenderState {
  index: number;
  selected: boolean;
}

export interface ListViewportProps<T> {
  items: readonly T[];
  selectedIndex: number;
  getKey: (item: T) => string;
  renderItem: (item: T, state: ListItemRenderState) => ReactNode;
  visibleRows?: number;
  empty?: ReactNode;
}

function overflowLabel(aboveCount: number, belowCount: number): string | null {
  if (aboveCount > 0 && belowCount > 0) {
    return `... ${aboveCount} above, ${belowCount} more`;
  }
  if (aboveCount > 0) {
    return `... ${aboveCount} above`;
  }
  if (belowCount > 0) {
    return `... and ${belowCount} more`;
  }
  return null;
}

export function ListViewport<T>({
  items,
  selectedIndex,
  getKey,
  renderItem,
  visibleRows,
  empty = <Text dimColor>No matches</Text>,
}: ListViewportProps<T>) {
  const rowCount =
    visibleRows === undefined ? Math.max(1, items.length) : Math.max(1, Math.floor(visibleRows));
  const visibleWindow =
    visibleRows === undefined
      ? { start: 0, end: items.length, aboveCount: 0, belowCount: 0 }
      : getVisibleWindow({
          selectedIndex,
          itemCount: items.length,
          visibleRowCount: rowCount,
        });
  const visible = items.slice(visibleWindow.start, visibleWindow.end);
  const overflowText = overflowLabel(visibleWindow.aboveCount, visibleWindow.belowCount);
  const renderedRows = visible.length + (overflowText !== null || items.length === 0 ? 1 : 0);
  const blankRows = visibleRows === undefined ? 0 : Math.max(0, rowCount - renderedRows);

  return (
    <Box
      flexDirection="column"
      height={visibleRows === undefined ? undefined : rowCount}
      overflow="hidden"
    >
      {visible.length === 0
        ? empty
        : visible.map((item, offset) => {
            const index = visibleWindow.start + offset;
            return (
              <Box key={getKey(item)}>
                {renderItem(item, { index, selected: index === selectedIndex })}
              </Box>
            );
          })}
      {overflowText ? <Text dimColor>{overflowText}</Text> : null}
      {Array.from({ length: blankRows }, (_, index) => (
        <Text key={`blank_${index}`}> </Text>
      ))}
    </Box>
  );
}
