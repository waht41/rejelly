/**
 * Ink UI: `<Static>` history + transient view + prompt + working stream.
 */

import type { DOMElement } from "ink";
import { Box, measureElement, Text, useInput, useWindowSize } from "ink";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  type PromptInput,
  promptInputPlainText,
  textPromptInput,
} from "../../shared/model/prompt/promptInput";
import { hasActiveInterruptibleTask } from "../../shared/task-interruption/taskStack";
import { AssistantStreamView } from "../conversation-display/assistant-stream/AssistantStreamView";
import { StaticHistory } from "../conversation-display/history/StaticHistory";
import { RunningToolList } from "../conversation-display/running-tools/RunningToolList";
import { RuntimeStatusLine } from "../conversation-display/runtime-status/RuntimeStatusLine";
import { isRuntimeActive } from "../conversation-display/runtime-status/state";
import { ToolTranscriptOverlay } from "../conversation-display/tool-transcript/ToolTranscriptOverlay";
import { useToolTranscriptViewStore } from "../conversation-display/tool-transcript/viewStore";
import { useOutputStore } from "../conversation-display/useOutputStore";
import { McpManagerPrompt } from "../mcp-manager/McpManagerPrompt";
import { MemoryManagerPrompt } from "../memory-manager/MemoryManagerPrompt";
import { MessageComposer } from "../message-composer/MessageComposer";
import { useComposerSession } from "../message-composer/session/composerSession";
import { ActionMenuPrompt } from "../operator-decision/ActionMenuPrompt";
import { ConfirmPrompt } from "../operator-decision/ConfirmPrompt";
import { DecisionDetail } from "../operator-decision/DecisionDetail";
import { useDecisionStore } from "../operator-decision/decisionStore";
import { TextDecisionPrompt } from "../operator-decision/TextDecisionPrompt";
import { SkillManagerPrompt } from "../skill-manager/SkillManagerPrompt";
import { getQueuedSteers, subscribeSteers } from "../submission-dispatch/steerQueue";
import { MODE_META, useModeStore } from "../tool-approval/approvalModeStore";
import { saveClipboardImage } from "./clipboard/clipboardImage";
import { copyTextToClipboard } from "./clipboard/clipboardText";
import { handleLocalCommand } from "./interactiveCommandBinding";
import { type CtrlCAbortHandler, useCtrlCAbort } from "./useCtrlCAbort";

const STEER_QUEUE_VISIBLE_ROWS = 3;
const OUTER_VERTICAL_MARGIN_ROWS = 2;
const TOOL_TAIL_MAX_ROWS = 8;

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

function SteerQueueList({ items, columns }: { items: PromptInput[]; columns: number }) {
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
        const attachmentCount = item.attachments.length;
        const attachmentSuffix = attachmentCount > 0 ? ` [+${attachmentCount} attachment(s)]` : "";
        const text = promptInputPlainText(item);
        return (
          <Box key={`${index}:${text}:${attachmentCount}`}>
            <Text color="yellow">~ </Text>
            <Text dimColor wrap="truncate-end">
              {truncateOneLine(`${text}${attachmentSuffix}`, textBudget)}
            </Text>
          </Box>
        );
      })}
      {hiddenCount > 0 ? <Text dimColor>... +{hiddenCount} more</Text> : null}
    </Box>
  );
}

export interface DashboardProps {
  onCtrlCAbort: CtrlCAbortHandler;
}

export function Dashboard({ onCtrlCAbort }: DashboardProps) {
  const { columns, rows } = useWindowSize();
  const history = useOutputStore((s) => s.history);
  const clearedStaticTurns = useOutputStore((s) => s.clearedStaticTurns);
  const streamBuffer = useOutputStore((s) => s.streamBuffer);
  const runningTools = useOutputStore((s) => s.runningTools);
  const phase = useOutputStore((s) => s.runtime.phase);

  const transcriptOpen = useToolTranscriptViewStore((s) => s.transcriptOpen);
  const openTranscript = useToolTranscriptViewStore((s) => s.openTranscript);
  const view = useDecisionStore((state) => state.view);
  const decision = useDecisionStore((state) => state.decision);
  const submitChoice = useDecisionStore((state) => state.submitChoice);
  const cancelChoice = useDecisionStore((state) => state.cancelChoice);
  const submitMcpManager = useDecisionStore((state) => state.submitMcpManager);
  const submitMemoryManager = useDecisionStore((state) => state.submitMemoryManager);
  const submitSkillManager = useDecisionStore((state) => state.submitSkillManager);
  const [queuedSteers, setQueuedSteers] = useState<PromptInput[]>(() => getQueuedSteers());

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
  const isAgentWorking = isRuntimeActive(phase, streamBuffer);
  const canShowLinePrompt = decision.type === "idle";
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
  useCtrlCAbort(onCtrlCAbort);

  useEffect(() => subscribeSteers(setQueuedSteers), []);

  // ctrl+o opens the tool transcript; ToolTranscriptOverlay handles its own close (Esc / ctrl+o)
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
      <StaticHistory turns={staticTurns} columns={columns} hideTransient={transcriptOpen} />

      {transcriptOpen ? (
        <ToolTranscriptOverlay />
      ) : (
        <Box flexDirection="column" marginTop={1} marginBottom={1}>
          <Box ref={topTransientRef} flexDirection="column">
            {runningTools.length > 0 ? (
              <RunningToolList tools={runningTools} maxTailRows={toolTailRows} />
            ) : null}
          </Box>
          <AssistantStreamView
            text={streamBuffer}
            columns={columns}
            maxRows={streamBudgetRows}
            visible={isAgentWorking}
          />
          <Box ref={bottomTransientRef} flexDirection="column">
            <DecisionDetail view={view} columns={columns} />
            <Box marginTop={1}>
              <RuntimeStatusLine />
            </Box>
            {decision.type === "mcp_manager" ? (
              <McpManagerPrompt
                request={decision.request}
                onAction={submitMcpManager}
                copyText={copyTextToClipboard}
              />
            ) : decision.type === "memory_manager" ? (
              <MemoryManagerPrompt request={decision.request} onAction={submitMemoryManager} />
            ) : decision.type === "skill_manager" ? (
              <SkillManagerPrompt request={decision.request} onAction={submitSkillManager} />
            ) : decision.type === "confirm" ? (
              <ConfirmPrompt message={decision.message} defaultYes={decision.defaultYes} />
            ) : decision.type === "choice" ? (
              <ActionMenuPrompt
                message={decision.message}
                options={decision.options}
                onSelect={submitChoice}
                onCancel={decision.cancelable ? cancelChoice : undefined}
              />
            ) : decision.type === "text" ? (
              <TextDecisionPrompt label={decision.label} />
            ) : canShowLinePrompt ? (
              <Box flexDirection="column">
                <Box
                  flexDirection="column"
                  borderStyle="single"
                  borderColor="gray"
                  borderTop={false}
                  borderLeft={false}
                  borderRight={false}
                  paddingX={1}
                >
                  <SteerQueueList items={queuedSteers} columns={columns} />
                  {isAgentWorking ? <Text dimColor> · /stop or Esc to interrupt</Text> : null}
                  <MessageComposer
                    label=""
                    isAgentRunning={isAgentWorking}
                    hasInterruptibleTask={hasActiveInterruptibleTask}
                    onInterrupt={() =>
                      useComposerSession.getState().submitLine(textPromptInput("/stop"))
                    }
                    onCycleMode={() => useModeStore.getState().cycleMode()}
                    onCommand={handleLocalCommand}
                    onNotice={(message) => useOutputStore.getState().logSystem(message)}
                    readClipboardImage={saveClipboardImage}
                  />
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
