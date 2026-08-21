import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import type {
  McpManagerAction,
  McpManagerRequest,
  McpManagerRow,
  McpManagerToolRow,
} from "../../shared/host/inputBindings";
import { ListViewport } from "../terminal-ui/picker/ListViewport";
import { moveListSelection } from "../terminal-ui/picker/listNavigation";

const VISIBLE_ROWS = 10;
const PAGE_STEP = 9;

interface DetailAction {
  label: string;
  action: "toggle" | "reload" | "permissions" | "tools";
}

function connectionColor(
  connection: McpManagerRow["connection"],
): "green" | "yellow" | "red" | undefined {
  if (connection === "ready") return "green";
  if (connection === "pending") return "yellow";
  if (connection === "failed" || connection === "untrusted") return "red";
  return undefined;
}

function approvalColor(approval: McpManagerToolRow["approval"]): "green" | "yellow" | undefined {
  if (approval === "always") return "green";
  if (approval === "session") return "yellow";
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
    ...(row.connection === "ready"
      ? [{ label: "Tools & approvals", action: "tools" as const }]
      : []),
    { label: "Reload connection", action: "reload" },
    ...(row.persistentAccess
      ? [{ label: "Revoke persistent server access", action: "permissions" as const }]
      : []),
  ];
}

function approvalAction(
  serverId: string,
  rows: readonly McpManagerToolRow[],
  approval: "ask" | "session" | "always",
): McpManagerAction {
  return {
    action: "set_tool_approval",
    serverId,
    tools: rows.map((row) => ({
      nativeToolName: row.nativeToolName,
      configFingerprint: row.configFingerprint,
      toolSchemaFingerprint: row.toolSchemaFingerprint,
    })),
    approval,
  };
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
  const [toolsVisible, setToolsVisible] = useState(Boolean(request.toolPanel));
  const [toolIndex, setToolIndex] = useState(0);
  const [selectedTools, setSelectedTools] = useState<ReadonlySet<string>>(new Set());
  const [searching, setSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [confirmAlways, setConfirmAlways] = useState<readonly McpManagerToolRow[]>();
  const serverWidth = Math.min(28, Math.max(8, ...request.rows.map((row) => row.serverId.length)));
  const activeDetailServerId = request.activity?.serverId ?? detailServerId;
  const detailRow = request.rows.find((row) => row.serverId === activeDetailServerId);
  const actions = detailRow ? detailActions(detailRow) : [];
  const visibleTools = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!query) return request.toolPanel?.rows ?? [];
    return (request.toolPanel?.rows ?? []).filter(
      (row) =>
        row.nativeToolName.toLocaleLowerCase().includes(query) ||
        row.description.toLocaleLowerCase().includes(query),
    );
  }, [request.toolPanel?.rows, searchQuery]);

  useEffect(() => setSelectedIndex(initialIndex), [initialIndex]);
  useEffect(() => {
    setDetailServerId(request.detailServerId);
    setDetailActionIndex(0);
  }, [request.detailServerId]);
  useEffect(() => {
    if (!request.toolPanel) return;
    setToolsVisible(true);
    setToolIndex(0);
    setSelectedTools(new Set());
    setConfirmAlways(undefined);
  }, [request.toolPanel]);

  useInput((input, key) => {
    if (request.activity) {
      if (key.escape) onAction({ action: "cancel" });
      return;
    }
    if (toolsVisible && request.toolPanel) {
      if (confirmAlways) {
        if (key.escape) setConfirmAlways(undefined);
        else if (key.return) {
          onAction(approvalAction(request.toolPanel.serverId, confirmAlways, "always"));
        }
        return;
      }
      if (searching) {
        if (key.escape || key.return) setSearching(false);
        else if (key.backspace || key.delete) setSearchQuery((current) => current.slice(0, -1));
        else if (input && !key.ctrl && !key.meta) setSearchQuery((current) => current + input);
        return;
      }
      if (key.escape) {
        if (selectedTools.size > 0) setSelectedTools(new Set());
        else setToolsVisible(false);
        return;
      }
      if (input === "/") {
        setSearching(true);
        return;
      }
      if (key.ctrl && input.toLocaleLowerCase() === "a") {
        setSelectedTools(new Set(visibleTools.map((row) => row.nativeToolName)));
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
        setToolIndex((previous) =>
          moveListSelection({
            selectedIndex: previous,
            itemCount: visibleTools.length,
            command,
            mode: key.upArrow || key.downArrow ? "wrap" : undefined,
            pageStep: PAGE_STEP,
          }),
        );
        return;
      }
      const focused = visibleTools[toolIndex];
      if ((key.return || input === " ") && focused) {
        setSelectedTools((current) => {
          const next = new Set(current);
          if (next.has(focused.nativeToolName)) next.delete(focused.nativeToolName);
          else next.add(focused.nativeToolName);
          return next;
        });
        return;
      }
      const targets =
        selectedTools.size > 0
          ? (request.toolPanel.rows.filter((row) => selectedTools.has(row.nativeToolName)) ?? [])
          : focused
            ? [focused]
            : [];
      if (targets.length === 0) return;
      if (input.toLocaleLowerCase() === "s") {
        onAction(approvalAction(request.toolPanel.serverId, targets, "session"));
      } else if (input.toLocaleLowerCase() === "r") {
        onAction(approvalAction(request.toolPanel.serverId, targets, "ask"));
      } else if (input.toLocaleLowerCase() === "a") {
        if (targets.length > 1) setConfirmAlways(targets);
        else onAction(approvalAction(request.toolPanel.serverId, targets, "always"));
      }
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

  if (toolsVisible && request.toolPanel) {
    const counts = { ask: 0, session: 0, always: 0 };
    for (const row of request.toolPanel.rows) counts[row.approval] += 1;
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>MCP · {request.toolPanel.serverId} · Tools & approvals</Text>
        <Text dimColor>
          {counts.always} always · {counts.session} session · {counts.ask} ask
        </Text>
        {searchQuery || searching ? (
          <Text color={searching ? "cyan" : undefined}>Search: {searchQuery || "_"}</Text>
        ) : null}
        <Box flexDirection="column" marginTop={1}>
          <ListViewport
            items={visibleTools}
            selectedIndex={toolIndex}
            getKey={(row) => row.nativeToolName}
            visibleRows={VISIBLE_ROWS}
            empty={<Text dimColor>No matching tools in the current catalog.</Text>}
            renderItem={(row, { selected }) => (
              <Text color={selected ? "cyan" : undefined} bold={selected}>
                {selected ? "▸ " : "  "}[{selectedTools.has(row.nativeToolName) ? "✓" : " "}]{" "}
                {row.nativeToolName} ·{" "}
                <Text color={approvalColor(row.approval)}>{row.approval}</Text>
                {row.description ? ` · ${row.description}` : ""}
              </Text>
            )}
          />
        </Box>
        {confirmAlways ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color="yellow">Always allow {confirmAlways.length} tools?</Text>
            <Text dimColor>Schema-bound; changed tools will require approval again.</Text>
            <Text>Enter confirm · Esc cancel</Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            {selectedTools.size > 0 ? <Text>{selectedTools.size} selected</Text> : null}
            <Text dimColor>
              Space/Enter select · S session · A always · R revoke · / search · Esc back
            </Text>
          </Box>
        )}
      </Box>
    );
  }

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
