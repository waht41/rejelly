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

interface DetailAction {
  label: string;
  action: "toggle" | "reload" | "permissions";
}

function connectionColor(
  connection: McpManagerRow["connection"],
): "green" | "yellow" | "red" | undefined {
  if (connection === "ready") return "green";
  if (connection === "pending") return "yellow";
  if (connection === "failed" || connection === "untrusted") return "red";
  return undefined;
}

function detailActions(row: McpManagerRow): DetailAction[] {
  return [
    ...(row.persistentAccess && !row.selected
      ? []
      : [
          {
            label: row.selected ? "Remove from this session" : "Allow for this session",
            action: "toggle" as const,
          },
        ]),
    { label: "Reload connection", action: "reload" },
    { label: "Persistent permissions", action: "permissions" },
  ];
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
  const [detailServerId, setDetailServerId] = useState(request.detailServerId);
  const [detailActionIndex, setDetailActionIndex] = useState(0);
  const serverWidth = Math.min(28, Math.max(8, ...request.rows.map((row) => row.serverId.length)));
  const activeDetailServerId = request.activity?.serverId ?? detailServerId;
  const detailRow = request.rows.find((row) => row.serverId === activeDetailServerId);
  const actions = detailRow ? detailActions(detailRow) : [];

  useEffect(() => setSelectedIndex(initialIndex), [initialIndex]);
  useEffect(() => {
    setDetailServerId(request.detailServerId);
    setDetailActionIndex(0);
  }, [request.detailServerId]);

  useInput((_input, key) => {
    if (request.activity) {
      if (key.escape) onAction({ action: "cancel" });
      return;
    }
    if (detailRow) {
      if (key.escape) {
        setDetailServerId(undefined);
        setDetailActionIndex(0);
        return;
      }
      if (key.upArrow || key.downArrow || key.home || key.end) {
        setDetailActionIndex((previous) =>
          moveListSelection({
            selectedIndex: previous,
            itemCount: actions.length,
            command: key.home ? "home" : key.end ? "end" : key.upArrow ? "up" : "down",
            mode: key.upArrow || key.downArrow ? "wrap" : undefined,
          }),
        );
        return;
      }
      const selectedAction = actions[detailActionIndex];
      if (key.return && selectedAction) {
        onAction({ action: selectedAction.action, serverId: detailRow.serverId });
      }
      return;
    }
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
    if (key.return && selected) {
      setDetailServerId(selected.serverId);
      setDetailActionIndex(0);
    }
  });

  if (detailRow) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>MCP · {detailRow.serverId}</Text>
        <Box flexDirection="column" marginTop={1}>
          <Text>
            Status:{" "}
            <Text color={connectionColor(detailRow.connection)}>{detailRow.connection}</Text>
          </Text>
          <Text>Source: {detailRow.source}</Text>
          <Text>Tools: {detailRow.toolCount}</Text>
          {detailRow.persistentAccess ? <Text>Access: persistent</Text> : null}
          {detailRow.detail ? <Text color="red">{detailRow.detail}</Text> : null}
        </Box>
        {request.activity ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color="yellow">◌ {request.activity.label}</Text>
            <Text dimColor>Esc cancel startup</Text>
          </Box>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {actions.map((action, index) => (
              <Text
                key={action.action}
                color={index === detailActionIndex ? "cyan" : undefined}
                bold={index === detailActionIndex}
              >
                {index === detailActionIndex ? "▸ " : "  "}
                {action.label}
              </Text>
            ))}
            <Text dimColor>↑/↓ move · Enter select · Esc back</Text>
          </Box>
        )}
      </Box>
    );
  }

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
      <Text dimColor>↑/↓ move · Enter details · Esc close</Text>
    </Box>
  );
}
