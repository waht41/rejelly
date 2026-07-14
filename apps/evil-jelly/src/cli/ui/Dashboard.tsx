/**
 * Ink UI: `<Static>` history + transient view + prompt + working stream.
 */

import type { DOMElement } from "ink";
import { Box, measureElement, Static, Text, useInput, useWindowSize } from "ink";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getQueuedSteers, subscribeSteers } from "../../services/steer/steerControl";
import type { LineInputValue } from "../../shared/AgentShared";
import { MODE_META, useModeStore } from "../store/useModeStore";
import { isRuntimeActive, useOutputStore } from "../store/useOutputStore";
import { usePromptStore } from "../store/usePromptStore";
import { useViewStore } from "../store/useViewStore";
import { HistoryItem } from "./HistoryItem";
import { ActionMenuPrompt } from "./prompts/ActionMenuPrompt";
import { ConfirmPrompt } from "./prompts/ConfirmPrompt";
import { SmartLinePrompt } from "./prompts/SmartLinePrompt";
import { createStreamTailWindow } from "./streamWindow";
import { TranscriptOverlay } from "./TranscriptOverlay";
import { TransientPane } from "./TransientPane";
import { type CtrlCAbortHandler, useCtrlCAbort } from "./useCtrlCAbort";
import { StreamMarkdownViewer } from "./viewers/MarkdownViewer";

const STEER_QUEUE_VISIBLE_ROWS = 3;
const OUTER_VERTICAL_MARGIN_ROWS = 2;

interface LayoutRows {
  topTransient: number;
  bottomTransient: number;
}

function truncateOneLine(text: string, maxChars: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxChars) {
    return oneLine;
  }
  if (maxChars <= 3) {
    return oneLine.slice(0, maxChars);
  }
  return `${oneLine.slice(0, maxChars - 3)}...`;
}

function ModeBadge() {
  const mode = useModeStore((s) => s.mode);
  const meta = MODE_META[mode];
  return (
    <Box paddingX={1}>
      <Text color={meta.color} bold>
        ● {meta.label}
      </Text>
      <Text dimColor> {meta.hint} · shift+tab or /mode</Text>
    </Box>
  );
}

function ToolProgressList({ items }: { items: string[] }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {items.map((line, index) => (
        <Box key={`${index}:${line}`}>
          <Text color="green">● </Text>
          <Text dimColor>{line}</Text>
        </Box>
      ))}
    </Box>
  );
}

function SteerQueueList({ items, columns }: { items: LineInputValue[]; columns: number }) {
  if (items.length === 0) {
    return null;
  }
  const visible = items.slice(0, STEER_QUEUE_VISIBLE_ROWS);
  const hiddenCount = items.length - visible.length;
  const textBudget = Math.max(20, Math.min(120, columns - 18));
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>Queued steer ({items.length})</Text>
      {visible.map((item, index) => {
        const attachmentCount = item.attachments?.length ?? 0;
        const attachmentSuffix = attachmentCount > 0 ? ` [+${attachmentCount} attachment(s)]` : "";
        return (
          <Box key={`${index}:${item.text}:${attachmentCount}`}>
            <Text color="yellow">~ </Text>
            <Text dimColor wrap="truncate-end">
              {truncateOneLine(`${item.text}${attachmentSuffix}`, textBudget)}
            </Text>
          </Box>
        );
      })}
      {hiddenCount > 0 ? <Text dimColor>... +{hiddenCount} more</Text> : null}
    </Box>
  );
}

export function Dashboard({ onCtrlCAbort }: { onCtrlCAbort: CtrlCAbortHandler }) {
  const { columns, rows } = useWindowSize();
  const history = useOutputStore((s) => s.history);
  const clearedStaticTurns = useOutputStore((s) => s.clearedStaticTurns);
  const streamBuffer = useOutputStore((s) => s.streamBuffer);
  const toolProgress = useOutputStore((s) => s.toolProgress);
  const status = useOutputStore((s) => s.status);

  const transcriptOpen = useViewStore((s) => s.transcriptOpen);
  const openTranscript = useViewStore((s) => s.openTranscript);
  const view = usePromptStore((s) => s.view);
  const prompt = usePromptStore((s) => s.prompt);
  const [queuedSteers, setQueuedSteers] = useState<LineInputValue[]>(() => getQueuedSteers());

  // Ink's <Static> counts flushed items in instance state, so its items array must only grow
  // while mounted. `/clear` moves wiped turns into clearedStaticTurns (an already-flushed
  // prefix) instead of shrinking, so the post-clear banner/summary still get flushed; the
  // visible wipe is clearScreen's job.
  const staticTurns = useMemo(
    () => (clearedStaticTurns.length === 0 ? history : [...clearedStaticTurns, ...history]),
    [clearedStaticTurns, history],
  );

  const isAgentWorking = isRuntimeActive(status, streamBuffer);
  const canShowLinePrompt = prompt.type !== "confirm" && prompt.type !== "actionMenu";
  const lineLabel = prompt.type === "line" ? prompt.label : "";
  const topTransientRef = useRef<DOMElement>(null);
  const bottomTransientRef = useRef<DOMElement>(null);
  const [layoutRows, setLayoutRows] = useState<LayoutRows | null>(null);

  useLayoutEffect(() => {
    const nextRows: LayoutRows = {
      topTransient: topTransientRef.current ? measureElement(topTransientRef.current).height : 0,
      bottomTransient: bottomTransientRef.current
        ? measureElement(bottomTransientRef.current).height
        : 0,
    };
    setLayoutRows((previousRows) =>
      previousRows &&
      previousRows.topTransient === nextRows.topTransient &&
      previousRows.bottomTransient === nextRows.bottomTransient
        ? previousRows
        : nextRows,
    );
  });

  const nonStreamRows =
    layoutRows === null
      ? null
      : layoutRows.topTransient + layoutRows.bottomTransient + OUTER_VERTICAL_MARGIN_ROWS;
  const streamBudgetRows = nonStreamRows === null ? 0 : Math.max(0, rows - 1 - nonStreamRows - 1);
  const streamWindow = useMemo(
    () =>
      createStreamTailWindow({
        text: streamBuffer,
        columns,
        maxRows: streamBudgetRows,
      }),
    [columns, streamBuffer, streamBudgetRows],
  );
  const canRenderStream = isAgentWorking && streamWindow.text.length > 0;

  useCtrlCAbort(onCtrlCAbort);

  useEffect(() => subscribeSteers(setQueuedSteers), []);

  // ctrl+o opens transcript overlay; TranscriptOverlay handles its own close (Esc / ctrl+o)
  useInput((input, key) => {
    if (!transcriptOpen && key.ctrl && input === "o") {
      openTranscript();
    }
  });

  // Keep <Static> mounted across transcript open/close. Ink's <Static> tracks in instance
  // state how many items it has already flushed to scrollback; returning only the overlay
  // unmounts it, and the fresh instance created on close re-emits every history item — which
  // is appended to fullStaticOutput again and printed a second time. Rendering the overlay as
  // a sibling keeps the same <Static> instance mounted, so nothing gets re-flushed.
  return (
    <>
      <Static items={staticTurns}>{(turn) => <HistoryItem key={turn.id} turn={turn} />}</Static>

      {transcriptOpen ? (
        <TranscriptOverlay />
      ) : (
        <Box flexDirection="column" marginTop={1} marginBottom={1}>
          <Box ref={topTransientRef} flexDirection="column">
            {toolProgress.length > 0 ? <ToolProgressList items={toolProgress} /> : null}
          </Box>
          {canRenderStream ? (
            <Box flexDirection="column" marginBottom={1}>
              {streamWindow.forceRaw ? (
                <Text>{streamWindow.text}</Text>
              ) : (
                <StreamMarkdownViewer text={streamWindow.text} columns={columns} />
              )}
            </Box>
          ) : null}
          <Box ref={bottomTransientRef} flexDirection="column">
            <TransientPane view={view} />
            {prompt.type === "confirm" ? (
              <ConfirmPrompt message={prompt.message} defaultYes={prompt.defaultYes} />
            ) : prompt.type === "actionMenu" ? (
              <ActionMenuPrompt message={prompt.message} options={prompt.options} />
            ) : canShowLinePrompt ? (
              <Box flexDirection="column">
                <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
                  <SteerQueueList items={queuedSteers} columns={columns} />
                  {isAgentWorking ? (
                    <Text dimColor color="yellow">
                      Agent is running. Type /stop or press Esc to interrupt; exit to quit.
                    </Text>
                  ) : null}
                  <SmartLinePrompt label={lineLabel} />
                </Box>
                <ModeBadge />
              </Box>
            ) : null}
          </Box>
        </Box>
      )}
    </>
  );
}
