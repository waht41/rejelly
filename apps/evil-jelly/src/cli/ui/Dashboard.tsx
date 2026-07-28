/**
 * Ink UI: `<Static>` history + transient view + prompt + working stream.
 */

import type { DOMElement } from "ink";
import { Box, measureElement, Static, Text, useInput, useWindowSize } from "ink";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getQueuedSteers, subscribeSteers } from "../../services/steer/steerControl";
import type { LineInputValue } from "../../shared/AgentShared";
import { composeToolTailWindow } from "../store/toolTailWindow";
import { MODE_META, useModeStore } from "../store/useModeStore";
import { isRuntimeActive, type RunningTool, useOutputStore } from "../store/useOutputStore";
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
const TOOL_TAIL_MAX_ROWS = 6;
// Colors cycle by ordinal so parallel tools are told apart at a glance, the way
// a prefixed multi-process runner does it.
const TOOL_TAIL_COLORS = ["cyan", "magenta", "yellow", "blue", "green", "red"] as const;

function toolTailColor(ordinal: number): string {
  return TOOL_TAIL_COLORS[(ordinal - 1) % TOOL_TAIL_COLORS.length] ?? "cyan";
}

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

/**
 * The running tools and, under them, one shared window of what they are printing.
 *
 * Every running tool always keeps its own headline row, so nothing disappears
 * just because it went quiet; only the output rows compete for the window. The
 * `#N │` prefix appears once the window actually holds more than one tool —
 * keyed off the window's contents rather than the number of running tools, so
 * rows don't gain and lose their prefix as tools come and go around them.
 */
function RunningToolList({ tools, maxTailRows }: { tools: RunningTool[]; maxTailRows: number }) {
  const rows = composeToolTailWindow(tools, maxTailRows);
  const prefixed = new Set(rows.map((row) => row.ordinal)).size > 1;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {tools.map((tool) => (
        <Box key={tool.id}>
          <Text color="green">● </Text>
          <Text color={toolTailColor(tool.ordinal)}>#{tool.ordinal} </Text>
          <Text dimColor wrap="truncate-end">
            {tool.summary}
            {tool.lineCount > 0
              ? ` (${tool.lineCount} line${tool.lineCount === 1 ? "" : "s"})`
              : ""}
          </Text>
        </Box>
      ))}
      {rows.length > 0 ? (
        <Box flexDirection="column" paddingLeft={2}>
          {rows.map((row, index) => (
            <Box key={`${row.ordinal}:${index}:${row.text}`}>
              {prefixed ? <Text color={toolTailColor(row.ordinal)}>#{row.ordinal} │ </Text> : null}
              {/* Truncate, never wrap: one 400-char line would otherwise eat the
                  whole window, and there is no scrollback to recover it from. */}
              <Text dimColor wrap="truncate-end">
                {row.text}
              </Text>
            </Box>
          ))}
        </Box>
      ) : null}
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
  const runningTools = useOutputStore((s) => s.runningTools);
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

  // The tail window lives inside the measured transient region, so the assistant
  // stream's budget already shrinks around it. Keep it a modest slice of the
  // terminal so a short window still leaves room for everything else.
  const toolTailRows = Math.max(0, Math.min(TOOL_TAIL_MAX_ROWS, Math.floor(rows / 4)));
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
            {runningTools.length > 0 ? (
              <RunningToolList tools={runningTools} maxTailRows={toolTailRows} />
            ) : null}
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
