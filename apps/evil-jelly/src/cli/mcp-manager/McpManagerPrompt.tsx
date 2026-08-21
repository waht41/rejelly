import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import type {
  McpManagerAction,
  McpManagerRequest,
  McpManagerRow,
} from "../../shared/host/inputBindings";
import { ListViewport } from "../terminal-ui/picker/ListViewport";
import { moveListSelection } from "../terminal-ui/picker/listNavigation";

const VISIBLE_ROWS = 10;
const PAGE_STEP = 9;

function connectionColor(connection: McpManagerRow["connection"]): string | undefined {
  if (connection === "ready") return "green";
  if (connection === "pending") return "yellow";
  if (connection === "failed" || connection === "untrusted") return "red";
  return undefined;
}

export function McpManagerPrompt({
  request,
  onAction,
}: {
  request: McpManagerRequest;
  onAction: (action: McpManagerAction) => void;
}) {
  const initialIndex = useMemo(
    () =>
      Math.max(
        0,
        request.rows.findIndex((row) => row.serverId === request.selectedServerId),
      ),
    [request.rows, request.selectedServerId],
  );
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);
  const serverWidth = Math.min(28, Math.max(8, ...request.rows.map((row) => row.serverId.length)));

  useEffect(() => setSelectedIndex(initialIndex), [initialIndex]);

  useInput((input, key) => {
    if (key.escape) {
      onAction({ action: "close" });
      return;
    }
    if (key.upArrow || key.downArrow || key.pageUp || key.pageDown || key.home || key.end) {
      const command = key.home
        ? "home"
        : key.end
          ? "end"
          : key.pageDown
            ? "page-down"
            : key.pageUp
              ? "page-up"
              : key.upArrow
                ? "up"
                : "down";
      setSelectedIndex((previous) =>
        moveListSelection({
          selectedIndex: previous,
          itemCount: request.rows.length,
          command,
          mode: key.upArrow || key.downArrow ? "wrap" : undefined,
          pageStep: PAGE_STEP,
        }),
      );
      return;
    }
    const selected = request.rows[selectedIndex];
    if (!selected) return;
    if (key.return || input === " ") {
      onAction({ action: "toggle", serverId: selected.serverId });
    } else if (input.toLowerCase() === "r") {
      onAction({ action: "reload", serverId: selected.serverId });
    } else if (input.toLowerCase() === "p") {
      onAction({ action: "permissions", serverId: selected.serverId });
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>MCP servers</Text>
      <Box flexDirection="column" marginTop={1}>
        <ListViewport
          items={request.rows}
          selectedIndex={selectedIndex}
          getKey={(row) => row.serverId}
          visibleRows={VISIBLE_ROWS}
          empty={<Text dimColor>No MCP servers configured. Use `evil mcp add …` first.</Text>}
          renderItem={(row, { selected }) => {
            const access = row.selected
              ? "session"
              : row.persistentAccess
                ? "always"
                : row.exposure === "always"
                  ? "configured"
                  : "not used";
            return (
              <Text color={selected ? "cyan" : undefined} bold={selected}>
                {selected ? "▸ " : "  "}
                {row.selected || row.routable ? "●" : "○"} {row.serverId.padEnd(serverWidth)}{" "}
                <Text color={connectionColor(row.connection)}>{row.connection.padEnd(9)}</Text>{" "}
                {access.padEnd(10)} {String(row.toolCount).padStart(3)} tools {row.source}
                {row.detail ? ` · ${row.detail}` : ""}
              </Text>
            );
          }}
        />
      </Box>
      <Text dimColor>
        ↑/↓ move · Enter/Space use or remove · R reload · P permissions · Esc close
      </Text>
    </Box>
  );
}
