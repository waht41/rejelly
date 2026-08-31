import type { Key } from "ink";
import { useInput } from "ink";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { type ListItemRenderState, ListViewport } from "../../terminal-ui/picker/ListViewport";
import { moveListSelection } from "../../terminal-ui/picker/listNavigation";

/** Handles one keypress; returns true when the picker consumed it. */
export type ComposerPickerKeyHandler = (input: string, key: Key) => boolean;

/** Shared-stdin slot through which the line editor gives an open picker first claim on input. */
export interface ComposerPickerKeySink {
  current: ComposerPickerKeyHandler | null;
}

interface ComposerPickerProps<T> {
  items: readonly T[];
  getKey: (item: T) => string;
  renderItem: (item: T, state: ListItemRenderState) => ReactNode;
  onSelect: (item: T) => void;
  /** Optional path-like navigation action, conventionally bound to Tab / Right Arrow. */
  onBrowse?: (item: T) => void;
  canBrowse?: (item: T) => boolean;
  onCancel: () => void;
  empty?: ReactNode;
  visibleRows?: number;
  keySink?: ComposerPickerKeySink;
}

export function ComposerPicker<T>({
  items,
  getKey,
  renderItem,
  onSelect,
  onBrowse,
  canBrowse,
  onCancel,
  empty,
  visibleRows,
  keySink,
}: ComposerPickerProps<T>) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    setSelectedIndex((previous) => Math.min(previous, Math.max(0, items.length - 1)));
  }, [items.length]);

  const handleKey: ComposerPickerKeyHandler = (_input, key) => {
    if (key.escape) {
      onCancel();
      return true;
    }
    if (key.upArrow || key.downArrow) {
      setSelectedIndex((previous) =>
        moveListSelection({
          selectedIndex: previous,
          itemCount: items.length,
          command: key.upArrow ? "up" : "down",
          mode: "wrap",
        }),
      );
      return true;
    }
    if (key.return) {
      const selected = items[selectedIndex];
      if (selected) {
        onSelect(selected);
      }
      // Do not let Enter submit the line beneath an empty picker.
      return true;
    }
    if ((key.tab || key.rightArrow) && onBrowse && canBrowse) {
      const selected = items[selectedIndex];
      if (selected && canBrowse(selected)) {
        onBrowse(selected);
        return true;
      }
    }
    return false;
  };

  useInput(handleKey, { isActive: keySink === undefined });

  // Republish each render so the shared-stdin host sees current items and selection.
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

  return (
    <ListViewport
      items={items}
      selectedIndex={selectedIndex}
      getKey={getKey}
      renderItem={renderItem}
      visibleRows={visibleRows}
      empty={empty}
    />
  );
}
