/**
 * Execution Tab Component
 *
 * Renders executionHistory.turns as selectable turn snapshots.
 * Some strategies can branch instead of appending messages monotonically, so
 * each turn is displayed from its own full message snapshot.
 */

import { getGenerationsForHost } from "@entities/trace/lib/treeFinder";
import { ErrorCard } from "@entities/trace/ui/inspector/ErrorCard";
import { Editor } from "@monaco-editor/react";
import { Popover, PopoverContent, PopoverTrigger } from "@shared/ui/popover";
import {
  collectUpdateEventsForGeneration,
  selectExecutionReplayForAgentGeneration,
} from "@widgets/trace-inspector/lib/generationViewModel";
import type { RoleType, Turn } from "@widgets/trace-inspector/ui/types";
import { Bot, Check, CheckCircle2, ChevronDown, Copy, Settings, User, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import type { ChatMessage, NormalizedTrace } from "src/entities/trace/types";

interface ExecutionTabProps {
  trace: NormalizedTrace.Trace;
  generation: NormalizedTrace.GenerationNode;
}

function getRoleIcon(role: RoleType) {
  switch (role) {
    case "user":
      return <User className="w-4 h-4" />;
    case "assistant":
      return <Bot className="w-4 h-4" />;
    case "system":
      return <Settings className="w-4 h-4" />;
    case "tool":
      return <Wrench className="w-4 h-4" />;
    default:
      return <User className="w-4 h-4" />;
  }
}

function getRoleLabel(role: RoleType): string {
  switch (role) {
    case "user":
      return "User";
    case "assistant":
      return "Assistant";
    case "system":
      return "System";
    case "tool":
      return "Tool";
    default:
      return role;
  }
}

/** Full message snapshot + turn outcome for one execution turn. */
interface ConversationStreamEntry {
  turn: Turn;
  messages: ChatMessage[];
}

interface MessageRecord {
  id: string;
  message: ChatMessage;
}

interface TurnMessageReference {
  turn: Turn;
  messageIds: string[];
  firstSeenMessageIds: string[];
}

interface ExecutionMarkdownModel {
  messages: MessageRecord[];
  turns: TurnMessageReference[];
}

type MessageContentSegment = { type: "text"; text: string } | { type: "image"; url: string };

const IMAGE_PLACEHOLDER_PREFIX = "[Image: ";
const TURN_RESULT_PREVIEW_LIMIT = 4000;

function splitMessageContent(content: string): MessageContentSegment[] {
  const segments: MessageContentSegment[] = [];
  const textLines: string[] = [];

  const flushText = () => {
    if (textLines.length === 0) {
      return;
    }

    const text = textLines.join("\n");
    if (text.length > 0) {
      segments.push({ type: "text", text });
    }
    textLines.length = 0;
  };

  for (const line of content.split("\n")) {
    if (line.startsWith(IMAGE_PLACEHOLDER_PREFIX) && line.endsWith("]")) {
      const url = line.slice(IMAGE_PLACEHOLDER_PREFIX.length, -1).trim();
      if (url.length > 0) {
        flushText();
        segments.push({ type: "image", url });
        continue;
      }
    }

    textLines.push(line);
  }

  flushText();
  return segments;
}

function getImageLabel(url: string): string {
  const dataImageMatch = /^data:image\/([^;,]+)[;,]/i.exec(url);
  if (dataImageMatch) {
    return `Image (${dataImageMatch[1].toUpperCase()})`;
  }
  return "Image";
}

function isRenderableImageUrl(url: string): boolean {
  return /^(data:image\/|https?:\/\/|blob:)/i.test(url);
}

function formatMessageContentForExport(content: string): string {
  return splitMessageContent(content)
    .map((segment) => {
      if (segment.type === "text") {
        return segment.text;
      }
      return segment.url.startsWith("data:image/")
        ? `[${getImageLabel(segment.url)}: inline data omitted]`
        : `[Image: ${segment.url}]`;
    })
    .join("\n");
}

function truncateForExport(value: string, limit = TURN_RESULT_PREVIEW_LIMIT): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit)}\n\n[truncated ${value.length - limit} characters]`;
}

function formatTurnResultPreviewForExport(output: string): {
  language: "json" | "text";
  preview: string;
  isJson: boolean;
} {
  try {
    const parsed = JSON.parse(output);
    return {
      language: "json",
      preview: truncateForExport(JSON.stringify(parsed, null, 2)),
      isJson: true,
    };
  } catch {
    return {
      language: "text",
      preview: truncateForExport(output),
      isJson: false,
    };
  }
}

function areToolCallsEqual(a: ChatMessage["toolCalls"], b: ChatMessage["toolCalls"]): boolean {
  if (!a || a.length === 0) {
    return !b || b.length === 0;
  }
  if (!b || a.length !== b.length) {
    return false;
  }

  return a.every((left, index) => {
    const right = b[index];
    return left.id === right.id && left.name === right.name && left.arguments === right.arguments;
  });
}

function areMessagesEqual(a: ChatMessage, b: ChatMessage): boolean {
  return (
    a.role === b.role &&
    a.content === b.content &&
    a.reasoning_content === b.reasoning_content &&
    a.toolCallId === b.toolCallId &&
    a.name === b.name &&
    areToolCallsEqual(a.toolCalls, b.toolCalls)
  );
}

function getCommonMessagePrefixLength(previous: ChatMessage[], current: ChatMessage[]): number {
  const maxLength = Math.min(previous.length, current.length);
  let index = 0;
  while (index < maxLength && areMessagesEqual(previous[index], current[index])) {
    index += 1;
  }
  return index;
}

function buildExecutionMarkdownModel(
  conversationStream: ConversationStreamEntry[],
): ExecutionMarkdownModel {
  const messages: MessageRecord[] = [];
  const turns: TurnMessageReference[] = [];
  let previousMessages: ChatMessage[] = [];
  let previousMessageIds: string[] = [];

  for (const { turn, messages: turnMessages } of conversationStream) {
    const prefixLength = getCommonMessagePrefixLength(previousMessages, turnMessages);
    const messageIds = previousMessageIds.slice(0, prefixLength);
    const firstSeenMessageIds: string[] = [];

    for (const message of turnMessages.slice(prefixLength)) {
      const id = `m${messages.length + 1}`;
      messages.push({ id, message });
      messageIds.push(id);
      firstSeenMessageIds.push(id);
    }

    turns.push({ turn, messageIds, firstSeenMessageIds });
    previousMessages = turnMessages;
    previousMessageIds = messageIds;
  }

  return { messages, turns };
}

function appendMessageMarkdown(md: string, msg: ChatMessage): string {
  let next = md;

  if (msg.role === "tool") {
    if (msg.name?.trim()) {
      next += `**Tool Name:** \`${msg.name}\`\n\n`;
    }
    if (msg.toolCallId?.trim()) {
      next += `**Tool Call ID:** \`${msg.toolCallId}\`\n\n`;
    }
  } else if (msg.toolCallId?.trim()) {
    next += `**Tool Call ID:** \`${msg.toolCallId}\`\n\n`;
  }

  if (msg.reasoning_content?.trim()) {
    next += `**Reasoning**\n\`\`\`text\n${msg.reasoning_content}\n\`\`\`\n\n`;
  }

  if (msg.toolCalls && msg.toolCalls.length > 0) {
    msg.toolCalls.forEach((tc) => {
      next += `**Tool Call:** \`${tc.name}\` (ID: ${tc.id})\n\`\`\`json\n${tc.arguments}\n\`\`\`\n\n`;
    });
  }

  if (msg.content?.trim()) {
    next += `\`\`\`text\n${formatMessageContentForExport(msg.content)}\n\`\`\`\n\n`;
  } else if (!msg.toolCalls || msg.toolCalls.length === 0) {
    next += `*(Empty message)*\n\n`;
  }

  return next;
}

/**
 * Serializes execution to Markdown as a message table plus per-turn references.
 * Turn messages are runtime snapshots, so repeated prefixes are represented by
 * message ids instead of being emitted again inside every turn.
 */
function generateMarkdownExport(
  conversationStream: ConversationStreamEntry[],
  title = "# Execution Trace Export",
): string {
  let md = `${title}\n\n`;
  const model = buildExecutionMarkdownModel(conversationStream);

  md += "## Messages\n\n";

  if (model.messages.length === 0) {
    md += "*(No messages)*\n\n";
  }

  for (const { id, message } of model.messages) {
    const role = getRoleLabel((message.role as RoleType) || "user").toUpperCase();
    md += `### ${id} ${role}\n\n`;
    md = appendMessageMarkdown(md, message);
  }

  md += "## Turns\n\n";

  for (const { turn, messageIds, firstSeenMessageIds } of model.turns) {
    md += `### Turn ${turn.id}\n\n`;
    md += `Input messages: ${messageIds.length > 0 ? messageIds.join(", ") : "(none)"}\n\n`;
    md += `First seen messages: ${
      firstSeenMessageIds.length > 0 ? firstSeenMessageIds.join(", ") : "(none)"
    }\n\n`;

    if (turn.status === "failed" && turn.error) {
      md += `**Error**\n\`\`\`json\n${JSON.stringify(turn.error, null, 2)}\n\`\`\`\n\n`;
    }

    if (turn.finalResult) {
      const resultPreview = formatTurnResultPreviewForExport(turn.finalResult.output);
      md += `**Result ${turn.finalResult.isCached ? "(Cached)" : ""}**\n\n`;
      md += `- Size: ${turn.finalResult.output.length} characters\n`;
      md += `- Format: ${resultPreview.isJson ? "JSON" : "text"}\n`;
      md += `- Export: preview only; inspect the trace UI for the full result\n\n`;
      md += `\`\`\`${resultPreview.language}\n${resultPreview.preview}\n\`\`\`\n\n`;
    }

    md += `---\n\n`;
  }

  return md;
}

function buildConversationStream(turns: Turn[]): ConversationStreamEntry[] {
  return turns.map((turn) => {
    return {
      turn,
      messages: turn.messages,
    };
  });
}

function downloadTextFile(fileName: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function getRoleColorClasses(role: RoleType) {
  switch (role) {
    case "system":
      return "bg-blue-500/20 text-blue-400";
    case "user":
      return "bg-green-500/20 text-green-400";
    case "assistant":
      return "bg-purple-500/20 text-purple-400";
    case "tool":
      return "bg-orange-500/20 text-orange-400";
    default:
      return "bg-gray-500/20 text-gray-400";
  }
}

function MessageItem({
  message,
  overrideRole,
  toolCallNameMap,
}: {
  message: ChatMessage;
  overrideRole?: RoleType;
  toolCallNameMap?: Map<string, string>;
}) {
  const role = overrideRole || (message.role as RoleType);
  const hasToolCalls = message.toolCalls && message.toolCalls.length > 0;
  const hasContent = Boolean(message.content?.trim());
  const contentSegments = useMemo(
    () => (hasContent ? splitMessageContent(message.content) : []),
    [hasContent, message.content],
  );
  const hasReasoningContent = Boolean(message.reasoning_content?.trim());
  const showTextBubble = hasContent || !hasToolCalls;
  const resolvedToolName =
    message.name ||
    (message.toolCallId && toolCallNameMap ? toolCallNameMap.get(message.toolCallId) : undefined);

  return (
    <div className="flex gap-3">
      <div
        className={`flex-shrink-0 w-8 h-8 rounded flex items-center justify-center ${getRoleColorClasses(role)}`}
      >
        {getRoleIcon(role)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className="text-[10px] font-semibold text-foreground">{getRoleLabel(role)}</span>
          {message.toolCallId && role !== "tool" && (
            <span className="text-[10px] text-muted-foreground font-mono">
              #{message.toolCallId}
            </span>
          )}
          {resolvedToolName && role === "tool" && (
            <span className="text-[10px] font-mono text-orange-400/95">
              {resolvedToolName}
              {message.toolCallId ? (
                <span className="text-muted-foreground ml-1">#{message.toolCallId}</span>
              ) : null}
            </span>
          )}
        </div>
        {hasReasoningContent && (
          <details className="mb-2 rounded border border-border/60 bg-muted/20 px-2 py-1.5 text-xs">
            <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
              Reasoning
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-background/40 p-2 text-[11px] text-foreground/90">
              {message.reasoning_content}
            </pre>
          </details>
        )}
        {hasToolCalls && (
          <div className="mb-2 max-h-96 space-y-2 overflow-y-auto rounded border border-orange-500/25 bg-orange-500/5 p-2">
            {message.toolCalls!.map((tc) => (
              <div key={tc.id} className="text-xs">
                <div className="font-mono text-[10px] text-orange-400/95">
                  {tc.name}
                  <span className="text-muted-foreground ml-1">#{tc.id}</span>
                </div>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-background/50 p-1.5 text-[10px] text-foreground/90">
                  {tc.arguments}
                </pre>
              </div>
            ))}
          </div>
        )}
        {showTextBubble && (
          <div className="max-h-48 overflow-y-auto bg-muted/30 rounded p-2 text-xs text-foreground">
            {hasContent ? (
              <div className="space-y-2">
                {contentSegments.map((segment, index) => {
                  if (segment.type === "text") {
                    return (
                      <div key={`text-${index}`} className="whitespace-pre-wrap break-words">
                        {segment.text}
                      </div>
                    );
                  }

                  return (
                    <figure
                      key={`image-${index}`}
                      className="inline-flex max-w-full flex-col gap-1 rounded border border-border/60 bg-background/40 p-1.5"
                    >
                      {isRenderableImageUrl(segment.url) ? (
                        <img
                          src={segment.url}
                          alt={getImageLabel(segment.url)}
                          className="max-h-56 max-w-full rounded object-contain"
                          loading="lazy"
                          referrerPolicy="no-referrer"
                        />
                      ) : null}
                      <figcaption className="max-w-full truncate font-mono text-[10px] text-muted-foreground">
                        {getImageLabel(segment.url)}
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
            ) : (
              <span className="text-muted-foreground italic">Empty message</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface OutputVisualizerProps {
  output: string;
}

function OutputVisualizer({ output }: OutputVisualizerProps) {
  let formattedValue: string = output;
  let language: string = "plaintext";
  let isJson = false;

  try {
    const parsed = JSON.parse(output);
    formattedValue = JSON.stringify(parsed, null, 2);
    language = "json";
    isJson = true;
  } catch {
    language = "plaintext";
  }

  const lineCount = formattedValue.split("\n").length;
  const calculatedHeight = Math.min(400, Math.max(150, lineCount * 20));

  return (
    <div className="border border-border rounded overflow-hidden">
      <Editor
        height={calculatedHeight}
        language={language}
        value={formattedValue}
        options={{
          readOnly: true,
          fontSize: 12,
          fontFamily: "JetBrains Mono, Fira Code, Consolas, Monaco, monospace",
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: "on",
          automaticLayout: true,
          lineNumbers: isJson ? "on" : "off",
          folding: isJson,
          renderLineHighlight: "none",
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          overviewRulerBorder: false,
          scrollbar: {
            vertical: "auto",
            horizontal: "auto",
          },
        }}
        theme="vs-dark"
      />
    </div>
  );
}

interface TurnBlockProps {
  turn: Turn;
  messages: ChatMessage[];
  turnIndex: number;
}

function TurnBlock({ turn, messages, turnIndex }: TurnBlockProps) {
  const toolCallNameMap = useMemo(() => {
    const map = new Map<string, string>();
    turn.messages.forEach((msg) => {
      msg.toolCalls?.forEach((tc) => {
        if (tc.id && tc.name) {
          map.set(tc.id, tc.name);
        }
      });
    });
    return map;
  }, [turn.messages]);

  return (
    <div className="flex flex-col gap-3 pb-6 border-b border-border last:border-0 last:pb-0">
      <div className="px-3">
        <span className="inline-flex items-center rounded bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground">
          Turn Index {turnIndex}
        </span>
      </div>
      {messages.length > 0 && (
        <div className="space-y-3 px-3">
          {messages.map((message, idx) => (
            <MessageItem
              key={`${turn.id}-msg-${idx}`}
              message={message}
              toolCallNameMap={toolCallNameMap}
            />
          ))}
        </div>
      )}

      {turn.status === "failed" && turn.error && (
        <div className="mx-3 p-3 border border-red-500/20 rounded bg-red-500/10">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-semibold text-red-400">
              Error in Turn {turn.id} (index {turnIndex})
            </span>
          </div>
          <ErrorCard error={turn.error} />
        </div>
      )}

      {turn.finalResult && (
        <div className="mx-3 p-3 border border-green-500/20 rounded bg-green-500/5">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle2 className="w-4 h-4 text-green-400" />
            <span className="text-xs font-semibold text-green-400">
              Turn {turn.id} Result (index {turnIndex})
            </span>
            {turn.finalResult.isCached && (
              <span className="text-[10px] text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded">
                Cached
              </span>
            )}
          </div>
          <OutputVisualizer output={turn.finalResult.output} />
        </div>
      )}
    </div>
  );
}

export function ExecutionTab({ trace, generation }: ExecutionTabProps) {
  const [isCopied, setIsCopied] = useState(false);
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const [isTurnMenuOpen, setIsTurnMenuOpen] = useState(false);
  const [selectedTurnIndex, setSelectedTurnIndex] = useState(-1);
  const updateEvents = collectUpdateEventsForGeneration(trace, generation);
  const replay = selectExecutionReplayForAgentGeneration(trace, generation, updateEvents);
  const executionHistory = replay?.executionHistory;
  const turns = executionHistory?.turns ?? [];
  const hostSpanId = generation.hostNodeId ?? generation.parentSpanId;
  const hostGenerations = (
    hostSpanId ? getGenerationsForHost(trace, hostSpanId) : [generation]
  ).filter((item): item is NormalizedTrace.GenerationNode => item.type === "generation");

  const conversationStream = useMemo(() => buildConversationStream(turns), [turns]);
  const resolvedTurnIndex =
    selectedTurnIndex === -1 || selectedTurnIndex >= conversationStream.length
      ? conversationStream.length - 1
      : selectedTurnIndex;
  const selectedTurnEntry = conversationStream[resolvedTurnIndex];
  const selectedTurnLabel =
    selectedTurnIndex === -1
      ? "Latest"
      : `Turn ${turns[resolvedTurnIndex]?.id ?? resolvedTurnIndex}`;

  const handleCopy = async () => {
    try {
      const markdown = generateMarkdownExport(conversationStream);
      await navigator.clipboard.writeText(markdown);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy execution trace:", err);
    }
  };

  const buildGenerationMarkdown = (targetGeneration: NormalizedTrace.GenerationNode) => {
    const targetUpdateEvents = collectUpdateEventsForGeneration(trace, targetGeneration);
    const targetReplay = selectExecutionReplayForAgentGeneration(
      trace,
      targetGeneration,
      targetUpdateEvents,
    );
    const targetTurns = targetReplay?.executionHistory?.turns ?? [];
    const targetConversationStream = buildConversationStream(targetTurns);

    return generateMarkdownExport(
      targetConversationStream,
      `# Generation ${targetGeneration.startEvent.generationId} Export`,
    );
  };

  const handleExportCurrentGeneration = () => {
    const markdown = buildGenerationMarkdown(generation);
    downloadTextFile(
      `generation-${generation.startEvent.generationId}.md`,
      markdown,
      "text/markdown;charset=utf-8",
    );
  };

  const handleExportAllGenerations = () => {
    const content = hostGenerations.map((item) => buildGenerationMarkdown(item)).join("\n\n");

    downloadTextFile(
      `generations-${hostSpanId ?? generation.spanId}.md`,
      content,
      "text/markdown;charset=utf-8",
    );
  };

  if (!executionHistory || turns.length === 0) {
    return (
      <div className="h-full flex flex-col overflow-auto">
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          No execution history available
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-2 p-2 border-b border-border/50 shrink-0">
        <div className="sticky left-2 z-10 flex items-center gap-1 rounded border border-border bg-muted/20 text-xs text-muted-foreground">
          <span className="pl-2">View:</span>
          <Popover open={isTurnMenuOpen} onOpenChange={setIsTurnMenuOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex min-w-24 items-center justify-between gap-2 px-2 py-1.5 font-medium text-foreground hover:bg-muted/50 transition-colors"
                aria-label="Select execution turn"
                title="Select execution turn"
              >
                <span>{selectedTurnLabel}</span>
                <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="max-h-72 w-56 overflow-y-auto p-1">
              <button
                type="button"
                className="w-full rounded px-2 py-1.5 text-left text-xs text-foreground hover:bg-muted"
                onClick={() => {
                  setSelectedTurnIndex(-1);
                  setIsTurnMenuOpen(false);
                }}
              >
                Latest (-1)
              </button>
              {turns.map((turn, turnIndex) => (
                <button
                  key={`${turn.id}-${turnIndex}`}
                  type="button"
                  className="w-full rounded px-2 py-1.5 text-left text-xs text-foreground hover:bg-muted"
                  onClick={() => {
                    setSelectedTurnIndex(turnIndex);
                    setIsTurnMenuOpen(false);
                  }}
                >
                  Turn {turn.id} (index {turnIndex})
                </button>
              ))}
            </PopoverContent>
          </Popover>
        </div>
        <div className="inline-flex rounded overflow-hidden border border-border bg-muted/20">
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            title="Copy to Markdown"
          >
            {isCopied ? (
              <>
                <Check className="w-3.5 h-3.5 text-green-500" />
                <span className="text-green-500">Copied</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>Copy</span>
              </>
            )}
          </button>
          <Popover open={isExportMenuOpen} onOpenChange={setIsExportMenuOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="px-2 py-1.5 border-l border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                aria-label="Open export menu"
                title="More export actions"
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-52 p-1">
              <button
                type="button"
                className="w-full rounded px-2 py-1.5 text-left text-xs text-foreground hover:bg-muted"
                onClick={() => {
                  handleExportCurrentGeneration();
                  setIsExportMenuOpen(false);
                }}
              >
                Export current generation
              </button>
              <button
                type="button"
                className="w-full rounded px-2 py-1.5 text-left text-xs text-foreground hover:bg-muted"
                onClick={() => {
                  handleExportAllGenerations();
                  setIsExportMenuOpen(false);
                }}
              >
                Export all generations
              </button>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-2 space-y-6">
        {selectedTurnEntry && (
          <TurnBlock
            key={selectedTurnEntry.turn.id}
            turn={selectedTurnEntry.turn}
            messages={selectedTurnEntry.messages}
            turnIndex={resolvedTurnIndex}
          />
        )}
      </div>
    </div>
  );
}
