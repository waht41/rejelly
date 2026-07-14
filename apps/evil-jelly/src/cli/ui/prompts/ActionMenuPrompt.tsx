import { Box, Text } from "ink";
import type { ActionMenuOption } from "../../store/usePromptStore";
import { usePromptStore } from "../../store/usePromptStore";
import { ListPicker } from "../pickers/ListPicker";

const LONG_MENU_VISIBLE_ROWS = 10;
const LONG_MENU_PAGE_STEP = 9;

export function ActionMenuPrompt({
  message,
  options,
}: {
  message: string;
  options: ActionMenuOption[];
}) {
  const submitActionChoice = usePromptStore((s) => s.submitActionChoice);
  const cancelOption =
    options.find((o) => o.value === "reject") ??
    options.find((o) => o.value === "skip") ??
    options.find((o) => o.value === "cancel") ??
    options.find((o) => o.value === "");
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
          onSelect={(option) => submitActionChoice(option.value)}
          onCancel={() => {
            if (cancelOption) {
              submitActionChoice(cancelOption.value);
            }
          }}
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
        {isLongMenu ? " · PgUp/PgDn page" : ""} · Esc reject/skip/cancel (if listed)
      </Text>
    </Box>
  );
}
