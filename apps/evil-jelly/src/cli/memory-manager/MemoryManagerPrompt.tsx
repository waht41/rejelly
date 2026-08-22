import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import type {
  MemoryManagerAction,
  MemoryManagerEntry,
  MemoryManagerRequest,
} from "../../shared/host/inputBindings";
import { ListViewport } from "../terminal-ui/picker/ListViewport";
import { moveListSelection } from "../terminal-ui/picker/listNavigation";

const VISIBLE_ROWS = 10;

function statusLabel(entry: MemoryManagerEntry): string {
  return entry.injectedStatus === "current"
    ? "current"
    : entry.injectedStatus === "pending_next_epoch"
      ? "pending next epoch"
      : entry.injectedStatus === "removed_next_epoch"
        ? "removed next epoch"
        : "not injected";
}

export function MemoryManagerPrompt({
  request,
  onAction,
}: {
  request: MemoryManagerRequest;
  onAction: (action: MemoryManagerAction) => void;
}) {
  const initialIndex = useMemo(
    () =>
      Math.max(
        0,
        request.entries.findIndex((entry) => entry.id === request.selectedId),
      ),
    [request.entries, request.selectedId],
  );
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);

  useEffect(() => setSelectedIndex(initialIndex), [initialIndex]);

  useInput((input, key) => {
    const selected = request.detail ?? request.entries[selectedIndex];
    if (input.toLocaleLowerCase() === "o") {
      if (request.canRevealFile && selected) {
        onAction({ action: "reveal_file", id: selected.id });
      }
      return;
    }
    if (request.detail) {
      if (key.escape || input.toLocaleLowerCase() === "b") {
        onAction({ action: "back" });
        return;
      }
      if (key.return) {
        if (request.canRevealFile && selected) {
          onAction({ action: "reveal_file", id: selected.id });
        }
        return;
      }
      return;
    }
    if (key.escape) {
      onAction({ action: "close" });
      return;
    }
    if (input.toLocaleLowerCase() === "r") {
      onAction({ action: "refresh" });
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
          itemCount: request.entries.length,
          command,
          mode: key.upArrow || key.downArrow ? "wrap" : undefined,
          pageStep: VISIBLE_ROWS - 1,
        }),
      );
      return;
    }
    if (key.return && selected) onAction({ action: "detail", id: selected.id });
  });

  if (request.detail) {
    const detail = request.detail;
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Memory · {detail.title}</Text>
        <Box flexDirection="column" marginTop={1}>
          <Text>ID: {detail.id}</Text>
          <Text>Scope: {detail.scope}</Text>
          <Text>Summary: {detail.summary}</Text>
          <Text>Revision: {detail.revision}</Text>
          <Text>Injected: {statusLabel(detail)}</Text>
          <Text>Detail:</Text>
          <Text>{detail.detail}</Text>
          <Text>Created: {detail.createdAt}</Text>
          <Text>Updated: {detail.updatedAt}</Text>
          <Text>Provenance:</Text>
          {detail.provenance.split("\n").map((line, index) => (
            <Text key={`${index}:${line}`} dimColor>
              {line || " "}
            </Text>
          ))}
        </Box>
        {request.canRevealFile ? (
          <Text dimColor>Enter or O reveal this memory file · Esc/B back</Text>
        ) : (
          <Text dimColor>Explorer is unavailable in this host · Esc/B back</Text>
        )}
        {request.message ? <Text color="green">{request.message}</Text> : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Persistent Memory</Text>
      {request.diagnostic ? <Text color="yellow">Warning: {request.diagnostic}</Text> : null}
      <Box flexDirection="column" marginTop={1}>
        <ListViewport
          items={request.entries}
          selectedIndex={selectedIndex}
          visibleRows={VISIBLE_ROWS}
          getKey={(entry) => entry.id}
          empty={<Text dimColor>No persistent memory entries.</Text>}
          renderItem={(entry, { selected }) => (
            <Text color={selected ? "cyan" : undefined} bold={selected} wrap="truncate-end">
              {selected ? "▸ " : "  "}[{entry.scope}] {entry.title} — {entry.summary} ·{" "}
              {statusLabel(entry)}
            </Text>
          )}
        />
      </Box>
      {request.message ? <Text color="green">{request.message}</Text> : null}
      <Text dimColor>
        ↑/↓ move · Enter details · O reveal selected memory file · R refresh · Esc close
      </Text>
    </Box>
  );
}
