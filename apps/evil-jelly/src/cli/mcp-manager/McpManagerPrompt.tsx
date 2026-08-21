import { Box, Text, useInput, useWindowSize } from "ink";
import { useEffect, useMemo, useState } from "react";
import stringWidth from "string-width";
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

function approvalColor(
  approval: McpManagerToolRow["approval"],
): "cyan" | "green" | "yellow" | undefined {
  if (approval === "always") return "green";
  if (approval === "session") return "yellow";
  if (approval === "auto") return "cyan";
  return undefined;
}

function fitCell(value: string, width: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (stringWidth(compact) <= width) return compact + " ".repeat(width - stringWidth(compact));
  if (width <= 1) return "…".slice(0, width);
  let fitted = "";
  for (const character of compact) {
    if (stringWidth(`${fitted}${character}…`) > width) break;
    fitted += character;
  }
  const truncated = `${fitted}…`;
  return truncated + " ".repeat(Math.max(0, width - stringWidth(truncated)));
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

export function mcpToolClipboardText(
  serverId: string,
  tool: McpManagerToolRow,
  kind: "schema" | "descriptor",
): string {
  const value =
    kind === "schema"
      ? tool.inputSchema
      : {
          serverId,
          nativeToolName: tool.nativeToolName,
          description: tool.description,
          inputSchema: tool.inputSchema,
        };
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function McpManagerPrompt({
  request,
  onAction,
  copyText,
}: {
  request: McpManagerRequest;
  onAction: (action: McpManagerAction) => void;
  copyText: (text: string) => Promise<void>;
}) {
  const { columns, rows: terminalRows } = useWindowSize();
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
  const [inspectedToolName, setInspectedToolName] = useState<string>();
  const [schemaLineIndex, setSchemaLineIndex] = useState(0);
  const [copyStatus, setCopyStatus] = useState<string>();
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
  const inspectedTool = request.toolPanel?.rows.find(
    (row) => row.nativeToolName === inspectedToolName,
  );
  const schemaLines = useMemo(
    () => (inspectedTool ? JSON.stringify(inspectedTool.inputSchema, null, 2).split("\n") : []),
    [inspectedTool],
  );
  const toolRowWidth = Math.max(38, columns - 2);
  const toolApprovalWidth = 7;
  const toolFlexibleWidth = Math.max(12, toolRowWidth - 6 - 6 - toolApprovalWidth);
  const toolNameWidth = Math.min(30, Math.max(10, Math.floor(toolFlexibleWidth * 0.35)));
  const toolDescriptionWidth = Math.max(1, toolFlexibleWidth - toolNameWidth);

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
    setInspectedToolName(undefined);
    setSchemaLineIndex(0);
  }, [request.toolPanel]);
  useEffect(() => setToolIndex(0), [searchQuery]);
  useEffect(() => {
    if (!copyStatus) return;
    const timer = setTimeout(() => setCopyStatus(undefined), 2_500);
    return () => clearTimeout(timer);
  }, [copyStatus]);

  useInput((input, key) => {
    if (request.activity) {
      if (key.escape) onAction({ action: "cancel" });
      return;
    }
    if (toolsVisible && request.toolPanel) {
      if (inspectedTool) {
        if (key.escape) {
          setInspectedToolName(undefined);
          setSchemaLineIndex(0);
          setCopyStatus(undefined);
        } else if (input.toLocaleLowerCase() === "y") {
          const kind = key.shift || input === "Y" ? "descriptor" : "schema";
          setCopyStatus("Copying…");
          void copyText(mcpToolClipboardText(request.toolPanel.serverId, inspectedTool, kind)).then(
            () => setCopyStatus(kind === "schema" ? "✓ Schema copied" : "✓ Full tool JSON copied"),
            (error: unknown) =>
              setCopyStatus(
                `Copy failed: ${error instanceof Error ? error.message : String(error)}`,
              ),
          );
        } else if (
          key.upArrow ||
          key.downArrow ||
          key.pageUp ||
          key.pageDown ||
          key.home ||
          key.end
        ) {
          const pageStep = Math.max(1, Math.min(12, terminalRows - 12));
          setSchemaLineIndex((current) => {
            if (key.home) return 0;
            if (key.end) return Math.max(0, schemaLines.length - pageStep);
            const delta = key.pageUp ? -pageStep : key.pageDown ? pageStep : key.upArrow ? -1 : 1;
            return Math.max(
              0,
              Math.min(Math.max(0, schemaLines.length - pageStep), current + delta),
            );
          });
        }
        return;
      }
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
      if (key.return && focused) {
        setInspectedToolName(focused.nativeToolName);
        setSchemaLineIndex(0);
        return;
      }
      if (input === " " && focused) {
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
      if (input.toLocaleLowerCase() === "y" && detailRow.failure?.detail) {
        setCopyStatus("Copying…");
        void copyText(detailRow.failure.detail).then(
          () => setCopyStatus("✓ Failure diagnostics copied"),
          (error: unknown) =>
            setCopyStatus(`Copy failed: ${error instanceof Error ? error.message : String(error)}`),
        );
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
    const counts = { ask: 0, auto: 0, session: 0, always: 0 };
    for (const row of request.toolPanel.rows) counts[row.approval] += 1;
    if (inspectedTool) {
      const visibleSchemaRows = Math.max(3, Math.min(12, terminalRows - 12));
      const lastSchemaLine = Math.min(schemaLines.length, schemaLineIndex + visibleSchemaRows);
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>
            MCP · {request.toolPanel.serverId} · {inspectedTool.nativeToolName}
          </Text>
          <Box flexDirection="column" marginTop={1}>
            <Text>
              Approval:{" "}
              <Text color={approvalColor(inspectedTool.approval)}>{inspectedTool.approval}</Text>
            </Text>
            <Text bold>Description</Text>
            <Text>{inspectedTool.description || "No description provided."}</Text>
            <Text bold>Input schema</Text>
            {schemaLines.slice(schemaLineIndex, lastSchemaLine).map((line, index) => (
              <Text key={`${schemaLineIndex + index}:${line}`} wrap="truncate-end">
                {line || " "}
              </Text>
            ))}
          </Box>
          <Text dimColor>
            Schema lines {schemaLineIndex + 1}-{lastSchemaLine} of {schemaLines.length} · ↑/↓ scroll
            · Y schema · Shift+Y full tool JSON · Esc back
          </Text>
          {copyStatus ? (
            <Text
              color={copyStatus.startsWith("Copy failed") ? "red" : "green"}
              wrap="truncate-end"
            >
              {copyStatus}
            </Text>
          ) : null}
        </Box>
      );
    }
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>MCP · {request.toolPanel.serverId} · Tools & approvals</Text>
        <Text dimColor>
          {counts.always} always · {counts.session} session · {counts.auto} auto · {counts.ask} ask
        </Text>
        {searchQuery || searching ? (
          <Text color={searching ? "cyan" : undefined}>Search: {searchQuery || "_"}</Text>
        ) : null}
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor wrap="truncate-end">
            {"      "}
            {fitCell("Tool", toolNameWidth)} │ {fitCell("Access", toolApprovalWidth)} │{" "}
            {fitCell("Description", toolDescriptionWidth)}
          </Text>
          <ListViewport
            items={visibleTools}
            selectedIndex={toolIndex}
            getKey={(row) => row.nativeToolName}
            visibleRows={VISIBLE_ROWS}
            empty={<Text dimColor>No matching tools in the current catalog.</Text>}
            renderItem={(row, { selected }) => {
              const name = fitCell(row.nativeToolName, toolNameWidth);
              const approval = fitCell(row.approval, toolApprovalWidth);
              const description = fitCell(row.description, toolDescriptionWidth);
              return (
                <Text color={selected ? "cyan" : undefined} bold={selected} wrap="truncate-end">
                  {selected ? "▸ " : "  "}[{selectedTools.has(row.nativeToolName) ? "✓" : " "}]{" "}
                  {name} │ <Text color={approvalColor(row.approval)}>{approval}</Text> │{" "}
                  {description}
                </Text>
              );
            }}
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
              Enter details · Space select · S session · A always · R revoke · / search · Esc back
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
          {detailRow.failure ? (
            <Box flexDirection="column">
              <Text color="red">Failure: {detailRow.failure.code}</Text>
              <Text color="red">{detailRow.failure.messageExcerpt}</Text>
              {detailRow.failure.messageTruncated ? (
                <Text dimColor>Message excerpt truncated</Text>
              ) : null}
              {detailRow.failure.detail ? <Text dimColor>Y copy failure diagnostics</Text> : null}
            </Box>
          ) : null}
          {copyStatus ? (
            <Text color={copyStatus.startsWith("Copy failed") ? "red" : "green"}>{copyStatus}</Text>
          ) : null}
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
                {row.failure ? ` · ${row.failure.code}` : ""}
              </Text>
            );
          }}
        />
      </Box>
      <Text dimColor>↑/↓ move · Enter details · Esc close</Text>
    </Box>
  );
}
