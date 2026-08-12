import type { Key } from "ink";
import { Box, Text, useInput } from "ink";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { getVisibleWindow, wrapIndex } from "./navigation";

type NavigationMode = "clamp" | "wrap";

/** Handles one keypress; returns true when the picker consumed it. */
export type PickerKeyHandler = (input: string, key: Key) => boolean;

/**
 * Mutable slot owned by a host that shares stdin with the picker (e.g. the line
 * editor under the @/slash overlays). While mounted with `keySink` set, the
 * picker publishes its key handler here instead of subscribing to stdin; the
 * host offers each key to the handler first and keeps whatever it declines.
 * Which keys the picker consumes depends on its props (pageStep, getHotkey), so
 * hosts must ask the handler rather than hardcode a key list.
 */
export interface PickerKeySink {
  current: PickerKeyHandler | null;
}

export interface ListPickerRenderState {
  index: number;
  selected: boolean;
}

export interface ListPickerProps<T> {
  items: T[];
  getId: (item: T) => string;
  renderItem: (item: T, state: ListPickerRenderState) => ReactNode;
  onSelect: (item: T) => void;
  onCancel: () => void;
  getHotkey?: (item: T) => string | undefined;
  emptyText?: string;
  footer?: ReactNode;
  maxVisibleRows?: number;
  navigation?: NavigationMode;
  pageStep?: number;
  selectedIndex?: number;
  onSelectedIndexChange?: (index: number) => void;
  isCancelInput?: (input: string, key: Key) => boolean;
  /** Delegated-input mode: publish the key handler into this slot instead of
   * reading stdin directly. See PickerKeySink. */
  keySink?: PickerKeySink;
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

export function ListPicker<T>({
  items,
  getId,
  renderItem,
  onSelect,
  onCancel,
  getHotkey,
  emptyText,
  footer,
  maxVisibleRows,
  navigation = "wrap",
  pageStep,
  selectedIndex: controlledSelectedIndex,
  onSelectedIndexChange,
  isCancelInput,
  keySink,
}: ListPickerProps<T>) {
  const [internalSelectedIndex, setInternalSelectedIndex] = useState(0);
  const selectedIndex = controlledSelectedIndex ?? internalSelectedIndex;
  const setSelectedIndex = (next: number | ((previous: number) => number)) => {
    const previous = selectedIndex;
    const resolved = typeof next === "function" ? next(previous) : next;
    if (controlledSelectedIndex === undefined) {
      setInternalSelectedIndex(resolved);
    }
    onSelectedIndexChange?.(resolved);
  };

  useEffect(() => {
    const next = Math.min(selectedIndex, Math.max(0, items.length - 1));
    if (next !== selectedIndex) {
      setSelectedIndex(next);
    }
  }, [items.length, selectedIndex]);

  const handleKey: PickerKeyHandler = (input, key) => {
    if (key.escape || isCancelInput?.(input, key)) {
      onCancel();
      return true;
    }
    if (key.upArrow) {
      setSelectedIndex((prev) =>
        navigation === "wrap" ? wrapIndex(prev - 1, items.length) : Math.max(0, prev - 1),
      );
      return true;
    }
    if (key.downArrow) {
      setSelectedIndex((prev) =>
        navigation === "wrap"
          ? wrapIndex(prev + 1, items.length)
          : Math.min(Math.max(0, items.length - 1), prev + 1),
      );
      return true;
    }
    if (pageStep !== undefined && (key.pageUp || (key.shift && key.tab))) {
      setSelectedIndex((prev) => Math.max(0, prev - pageStep));
      return true;
    }
    if (pageStep !== undefined && key.pageDown) {
      setSelectedIndex((prev) => Math.min(Math.max(0, items.length - 1), prev + pageStep));
      return true;
    }
    if (pageStep !== undefined && key.home) {
      setSelectedIndex(0);
      return true;
    }
    if (pageStep !== undefined && key.end) {
      setSelectedIndex(Math.max(0, items.length - 1));
      return true;
    }
    if (key.return) {
      // Consumed even with no highlighted item (empty list): Enter must not
      // leak to the host and submit the half-typed line under the picker.
      const selected = items[selectedIndex];
      if (selected) {
        onSelect(selected);
      }
      return true;
    }
    if (getHotkey && input) {
      const hit = items.find((item) => getHotkey(item)?.toLowerCase() === input.toLowerCase());
      if (hit) {
        onSelect(hit);
        return true;
      }
    }
    return false;
  };

  useInput(handleKey, { isActive: keySink === undefined });

  // Delegated-input mode: republish on every render so the sink always holds a
  // handler closing over the current items/selection; clear it on unmount.
  useEffect(() => {
    if (keySink) {
      keySink.current = handleKey;
    }
  });
  useEffect(() => {
    if (!keySink) {
      return;
    }
    return () => {
      keySink.current = null;
    };
  }, [keySink]);

  const visibleRowCount =
    maxVisibleRows === undefined
      ? Math.max(1, items.length)
      : Math.max(1, Math.floor(maxVisibleRows));
  const visibleWindow =
    maxVisibleRows === undefined
      ? {
          start: 0,
          end: items.length,
          aboveCount: 0,
          belowCount: 0,
        }
      : getVisibleWindow({
          selectedIndex,
          itemCount: items.length,
          visibleRowCount,
        });
  const visible = items.slice(visibleWindow.start, visibleWindow.end);
  const overflowText = overflowLabel(visibleWindow.aboveCount, visibleWindow.belowCount);
  const renderedRows = visible.length + (overflowText !== null || items.length === 0 ? 1 : 0);
  const blankRows = maxVisibleRows === undefined ? 0 : Math.max(0, visibleRowCount - renderedRows);

  return (
    <Box
      flexDirection="column"
      height={maxVisibleRows === undefined ? undefined : visibleRowCount}
      overflow="hidden"
    >
      {visible.length === 0 ? (
        <Text dimColor>{emptyText ?? "No matches"}</Text>
      ) : (
        visible.map((item, offset) => {
          const index = visibleWindow.start + offset;
          return (
            <Box key={getId(item)}>
              {renderItem(item, { index, selected: index === selectedIndex })}
            </Box>
          );
        })
      )}
      {overflowText ? <Text dimColor>{overflowText}</Text> : null}
      {Array.from({ length: blankRows }, (_, i) => (
        <Text key={`blank_${i}`}> </Text>
      ))}
      {footer ? <Box>{footer}</Box> : null}
    </Box>
  );
}
