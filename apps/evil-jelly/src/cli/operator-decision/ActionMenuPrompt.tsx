import { Box, Text } from "ink";
import { ListPicker } from "./ListPicker";
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

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{message}</Text>
      <Box flexDirection="column" marginTop={1}>
        <ListPicker
          items={options}
          getId={(option) => `${option.key}:${option.value}`}
          getHotkey={(option) => option.key}
          navigation="wrap"
          maxVisibleRows={isLongMenu ? LONG_MENU_VISIBLE_ROWS : undefined}
          pageStep={isLongMenu ? LONG_MENU_PAGE_STEP : undefined}
          onSelect={(option) => onSelect(option.value)}
          onCancel={() => onCancel?.()}
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
