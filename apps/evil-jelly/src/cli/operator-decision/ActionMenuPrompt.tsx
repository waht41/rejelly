import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { ListViewport } from "../terminal-ui/picker/ListViewport";
import { moveListSelection } from "../terminal-ui/picker/listNavigation";
import type { DecisionOption } from "./model";

const LONG_MENU_VISIBLE_ROWS = 10;
const LONG_MENU_PAGE_STEP = 9;

export function ActionMenuPrompt({
  message,
  options,
  onSelect,
  onCancel,
}: {
  message: string;
  options: DecisionOption[];
  onSelect: (value: string) => void;
  onCancel?: () => void;
}) {
  const isLongMenu = options.length > LONG_MENU_VISIBLE_ROWS;
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    setSelectedIndex((previous) => Math.min(previous, Math.max(0, options.length - 1)));
  }, [options.length]);

  useInput((input, key) => {
    if (key.escape) {
      onCancel?.();
      return;
    }
    if (key.upArrow || key.downArrow) {
      setSelectedIndex((previous) =>
        moveListSelection({
          selectedIndex: previous,
          itemCount: options.length,
          command: key.upArrow ? "up" : "down",
          mode: "wrap",
        }),
      );
      return;
    }
    if (
      isLongMenu &&
      (key.pageUp || (key.shift && key.tab) || key.pageDown || key.home || key.end)
    ) {
      const command = key.home ? "home" : key.end ? "end" : key.pageDown ? "page-down" : "page-up";
      setSelectedIndex((previous) =>
        moveListSelection({
          selectedIndex: previous,
          itemCount: options.length,
          command,
          pageStep: LONG_MENU_PAGE_STEP,
        }),
      );
      return;
    }
    if (key.return) {
      const selected = options[selectedIndex];
      if (selected) {
        onSelect(selected.value);
      }
      return;
    }
    if (input) {
      const selected = options.find((option) => option.key?.toLowerCase() === input.toLowerCase());
      if (selected) {
        onSelect(selected.value);
      }
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{message}</Text>
      <Box flexDirection="column" marginTop={1}>
        <ListViewport
          items={options}
          selectedIndex={selectedIndex}
          getKey={(option) => `${option.key}:${option.value}`}
          visibleRows={isLongMenu ? LONG_MENU_VISIBLE_ROWS : undefined}
          renderItem={(option, { selected }) => (
            <Text color={selected ? "cyan" : undefined} bold={selected}>
              {selected ? "▸ " : "  "}
              {option.key ? `[${option.key}] ` : ""}
              {option.label}
            </Text>
          )}
        />
      </Box>
      <Text dimColor>
        ↑/↓ move · Enter select · hotkey jumps
        {isLongMenu ? " · PgUp/PgDn page" : ""}
        {onCancel ? " · Esc cancel" : ""}
      </Text>
    </Box>
  );
}
