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

export type ComposerPickerItemCommand = "select" | "complete" | "browse";

export function composerPickerItemCommand(
  key: Pick<Key, "return" | "tab" | "rightArrow">,
  capabilities: { complete: boolean; browse: boolean },
): ComposerPickerItemCommand | null {
  if (key.return) return "select";
  if (key.tab && capabilities.complete) return "complete";
  if (key.rightArrow && capabilities.browse) return "browse";
  return null;
}

interface ComposerPickerProps<T> {
  items: readonly T[];
  getKey: (item: T) => string;
  renderItem: (item: T, state: ListItemRenderState) => ReactNode;
  onSelect: (item: T) => void;
  /** Optional completion action, conventionally bound to Tab. */
  onComplete?: (item: T) => void;
  /** Optional path-like navigation action, conventionally bound to Right Arrow. */
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
  onComplete,
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
    const selected = items[selectedIndex];
    if (key.return && !selected) {
      // Do not let Enter submit the line beneath an empty picker.
      return true;
    }
    if (!selected) {
      return false;
    }
    const itemCommand = composerPickerItemCommand(key, {
      complete: Boolean(onComplete),
      browse: Boolean(onBrowse && canBrowse?.(selected)),
    });
    if (itemCommand === "select") {
      onSelect(selected);
      return true;
    }
    if (itemCommand === "complete") {
      onComplete?.(selected);
      return true;
    }
    if (itemCommand === "browse") {
      onBrowse?.(selected);
      return true;
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
