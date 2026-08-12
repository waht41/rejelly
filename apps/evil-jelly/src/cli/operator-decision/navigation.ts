export function wrapIndex(index: number, itemCount: number): number {
  if (itemCount <= 0) {
    return 0;
  }
  return ((index % itemCount) + itemCount) % itemCount;
}

export interface VisibleWindow {
  start: number;
  end: number;
  resultRowCount: number;
  aboveCount: number;
  belowCount: number;
}

export function getVisibleWindow({
  selectedIndex,
  itemCount,
  visibleRowCount,
}: {
  selectedIndex: number;
  itemCount: number;
  visibleRowCount: number;
}): VisibleWindow {
  const normalizedVisibleRows = Math.max(1, Math.floor(visibleRowCount));
  const resultRowCount =
    itemCount > normalizedVisibleRows && normalizedVisibleRows > 1
      ? normalizedVisibleRows - 1
      : normalizedVisibleRows;
  const clampedSelectedIndex = Math.min(Math.max(0, selectedIndex), Math.max(0, itemCount - 1));
  const maxStart = Math.max(0, itemCount - resultRowCount);
  const start = Math.min(Math.max(0, clampedSelectedIndex - resultRowCount + 1), maxStart);
  const end = Math.min(itemCount, start + resultRowCount);

  return {
    start,
    end,
    resultRowCount,
    aboveCount: start,
    belowCount: Math.max(0, itemCount - end),
  };
}
