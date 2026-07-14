import { streamAIAnalyze } from "@entities/analyze/api";
import { useTraceStore } from "@entities/trace/store";
import { useCommandViewStore } from "@features/command-view";
import { useSelectionStore } from "@shared/store/useSelectionStore";
import { Markdown } from "@shared/ui/Markdown";
import {
  AlertCircle,
  Bot,
  Loader2,
  MessageSquareText,
  Plus,
  Send,
  Square,
  User,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ConversationHistory } from "./ConversationHistory";
import {
  type AssistantStep,
  createPanelMessageId,
  getConversationTitle,
  type PanelMessage,
  useAIPanelStore,
} from "./useAIPanelStore";

function appendReasoningStep(messages: PanelMessage[], id: string, delta: string) {
  return messages.map((message) => {
    if (message.id !== id) return message;
    const steps = message.steps ?? [];
    const last = steps.at(-1);
    if (last?.type === "reasoning") {
      return {
        ...message,
        steps: [...steps.slice(0, -1), { ...last, text: `${last.text}${delta}` }],
      };
    }
    return {
      ...message,
      steps: [...steps, { id: createPanelMessageId(), type: "reasoning" as const, text: delta }],
    };
  });
}

function appendToolStep(messages: PanelMessage[], id: string, toolName: string) {
  return messages.map((message) =>
    message.id === id
      ? {
          ...message,
          steps: [
            ...(message.steps ?? []),
            { id: createPanelMessageId(), type: "tool" as const, name: toolName },
          ],
        }
      : message,
  );
}

function appendAssistantText(messages: PanelMessage[], id: string, delta: string) {
  return messages.map((message) =>
    message.id === id ? { ...message, content: `${message.content}${delta}` } : message,
  );
}

function completeAssistantMessage(
  messages: PanelMessage[],
  id: string,
  content: string,
  status: PanelMessage["status"] = "completed",
) {
  return messages.map((message) =>
    message.id === id
      ? {
          ...message,
          content,
          status,
        }
      : message,
  );
}

function stepsSummaryLabel(steps: AssistantStep[], running: boolean) {
  if (running) {
    const last = steps.at(-1);
    return last?.type === "tool" ? `Running ${last.name}...` : "Thinking...";
  }
  const toolCount = steps.filter((step) => step.type === "tool").length;
  return toolCount > 0
    ? `Reasoning · ${toolCount} tool call${toolCount > 1 ? "s" : ""}`
    : "Reasoning";
}

function StepTimeline({ steps, running }: { steps: AssistantStep[]; running: boolean }) {
  const lastStep = steps.at(-1);
  return (
    <div className="mt-1.5 max-h-48 space-y-1.5 overflow-auto">
      {steps.map((step) =>
        step.type === "tool" ? (
          <div key={step.id} className="flex items-center gap-1.5 text-xs text-foreground/80">
            {running && step === lastStep ? (
              <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
            ) : (
              <Wrench className="h-3 w-3 shrink-0" />
            )}
            <code className="font-mono">{step.name}</code>
          </div>
        ) : (
          <div
            key={step.id}
            className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground"
          >
            {step.text}
          </div>
        ),
      )}
    </div>
  );
}

function ChatBubble({ message }: { message: PanelMessage }) {
  const isUser = message.role === "user";
  const isRunning = message.status === "running";
  const steps = message.steps ?? [];

  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div
        className={
          isUser
            ? "max-w-[82%] rounded-md border border-primary/20 bg-primary/10 text-foreground px-3 py-2 text-sm"
            : "max-w-[92%] rounded-md border border-border bg-muted/35 px-3 py-2 text-sm text-foreground"
        }
      >
        <div
          className={
            isUser
              ? "flex items-center justify-end gap-1.5 mb-1.5 text-xs text-primary/70"
              : "flex items-center gap-1.5 mb-1.5 text-xs text-muted-foreground"
          }
        >
          {isUser ? <User className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
          <span>{isUser ? "You" : "AI"}</span>
          {message.status === "running" && (
            <Loader2 className="ml-1 h-3 w-3 animate-spin opacity-80" />
          )}
          {message.status === "error" && <AlertCircle className="ml-1 h-3 w-3 text-destructive" />}
        </div>

        {!isUser && steps.length > 0 && (
          <details className="mb-2 rounded border border-border/70 bg-background/60 px-2 py-1.5">
            <summary className="cursor-pointer text-xs text-muted-foreground select-none">
              {stepsSummaryLabel(steps, isRunning)}
            </summary>
            <StepTimeline steps={steps} running={isRunning} />
          </details>
        )}

        {message.content ? (
          isUser ? (
            <div className="whitespace-pre-wrap leading-relaxed">{message.content}</div>
          ) : (
            <Markdown content={message.content} />
          )
        ) : (
          <div className="text-muted-foreground">...</div>
        )}
      </div>
    </div>
  );
}

export function AIPanel() {
  const closeAIPanel = useCommandViewStore((s) => s.closeAIPanel);
  const traceId = useTraceStore((s) => s.currentTraceId ?? s.normalizedTrace?.id ?? null);
  const activeNodeId = useSelectionStore((s) => s.activeNodeId);
  const activeNodeType = useSelectionStore((s) => s.activeNodeType);

  const currentConversationId = useAIPanelStore((s) => s.currentConversationId);
  const conversations = useAIPanelStore((s) => s.conversations);
  const input = useAIPanelStore((s) => s.input);
  const isLoading = useAIPanelStore((s) => s.isLoading);
  const loadingConversationId = useAIPanelStore((s) => s.loadingConversationId);
  const error = useAIPanelStore((s) => s.error);
  const setInput = useAIPanelStore((s) => s.setInput);
  const setLoading = useAIPanelStore((s) => s.setLoading);
  const setError = useAIPanelStore((s) => s.setError);
  const appendMessagesToConversation = useAIPanelStore((s) => s.appendMessagesToConversation);
  const updateConversationMessages = useAIPanelStore((s) => s.updateConversationMessages);
  const appendConversationHistory = useAIPanelStore((s) => s.appendConversationHistory);
  const renameConversation = useAIPanelStore((s) => s.renameConversation);
  const setConversationTitleFromPrompt = useAIPanelStore((s) => s.setConversationTitleFromPrompt);
  const createNewConversation = useAIPanelStore((s) => s.createNewConversation);
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const skipTitleCommitRef = useRef(false);
  const currentConversation = conversations.find(
    (conversation) => conversation.id === currentConversationId,
  );
  const messages = currentConversation?.messages ?? [];
  const history = currentConversation?.history ?? [];
  const currentConversationLoading = isLoading && loadingConversationId === currentConversationId;
  const title = currentConversation ? getConversationTitle(currentConversation) : "AI Analysis";

  const context = useMemo(
    () => ({
      traceId,
      conversationId: currentConversationId,
      activeNodeId,
      activeNodeType,
    }),
    [traceId, currentConversationId, activeNodeId, activeNodeType],
  );

  const lastMessage = messages.at(-1);
  const lastStep = lastMessage?.steps?.at(-1);
  const scrollKey = `${messages.length}:${lastMessage?.content.length ?? 0}:${
    lastMessage?.steps?.length ?? 0
  }:${lastStep?.type === "reasoning" ? lastStep.text.length : 0}:${lastMessage?.status ?? ""}`;

  useEffect(() => {
    if (scrollKey.length === 0) return;

    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [scrollKey]);

  useEffect(() => {
    if (!titleEditing) {
      setTitleDraft(title);
    }
  }, [title, titleEditing]);

  useEffect(() => {
    if (titleEditing) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
  }, [titleEditing]);

  const commitTitle = () => {
    if (skipTitleCommitRef.current) {
      skipTitleCommitRef.current = false;
      return;
    }
    if (currentConversation) {
      renameConversation(currentConversation.id, titleDraft);
    }
    setTitleEditing(false);
  };

  const startNewConversation = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    createNewConversation();
    inputRef.current?.focus();
  };

  const stopGeneration = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
  };

  const submit = async () => {
    const question = input.trim();
    if (!question || isLoading) return;
    const requestConversationId = currentConversationId;
    const requestContext = { ...context };

    const userMessage: PanelMessage = {
      id: createPanelMessageId(),
      role: "user",
      content: question,
      context: requestContext,
      status: "completed",
    };
    const assistantId = createPanelMessageId();
    const assistantMessage: PanelMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      steps: [],
      status: "running",
    };

    const requestHistory = history;
    setInput("");
    setError(null);
    setLoading(true, requestConversationId);
    setConversationTitleFromPrompt(requestConversationId, question);
    appendMessagesToConversation(requestConversationId, [userMessage, assistantMessage]);

    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      for await (const update of streamAIAnalyze(
        question,
        requestContext,
        requestHistory,
        abortController.signal,
      )) {
        if ("type" in update && update.type === "error") {
          setError(update.message);
          updateConversationMessages(requestConversationId, (prev) =>
            completeAssistantMessage(prev, assistantId, update.message, "error"),
          );
          break;
        }

        if ("type" in update && update.type === "reasoning_delta") {
          updateConversationMessages(requestConversationId, (prev) =>
            appendReasoningStep(prev, assistantId, update.content),
          );
          continue;
        }

        if ("type" in update && update.type === "tool_call") {
          updateConversationMessages(requestConversationId, (prev) =>
            appendToolStep(prev, assistantId, update.toolName),
          );
          continue;
        }

        if ("type" in update && update.type === "text_delta") {
          updateConversationMessages(requestConversationId, (prev) =>
            appendAssistantText(prev, assistantId, update.content),
          );
          continue;
        }

        if ("complete" in update && update.complete) {
          const response = update.response;
          updateConversationMessages(requestConversationId, (prev) =>
            completeAssistantMessage(
              prev,
              assistantId,
              response.message || "No analysis returned.",
            ),
          );
          appendConversationHistory(requestConversationId, [
            { role: "user", content: question, context: requestContext },
            ...(response.delta ?? []),
          ]);
        }
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        updateConversationMessages(requestConversationId, (prev) =>
          completeAssistantMessage(prev, assistantId, "Stopped.", "completed"),
        );
      } else {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        updateConversationMessages(requestConversationId, (prev) =>
          completeAssistantMessage(prev, assistantId, message, "error"),
        );
      }
    } finally {
      if (abortRef.current === abortController) {
        abortRef.current = null;
      }
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  return (
    <aside className="h-full min-h-0 w-full bg-background border-l border-border flex flex-col">
      <div className="h-12 shrink-0 border-b border-border px-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <MessageSquareText className="h-4 w-4 text-primary shrink-0" />
          {titleEditing ? (
            <input
              ref={titleInputRef}
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
              onBlur={commitTitle}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitTitle();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  skipTitleCommitRef.current = true;
                  setTitleDraft(title);
                  setTitleEditing(false);
                }
              }}
              className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm font-medium outline-none focus:border-primary/70"
            />
          ) : (
            <button
              type="button"
              onDoubleClick={() => setTitleEditing(true)}
              className="min-w-0 flex-1 truncate text-left text-sm font-medium text-foreground"
              title={title}
            >
              {title}
            </button>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <ConversationHistory />
          <button
            type="button"
            className="h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40"
            onClick={startNewConversation}
            disabled={isLoading && messages.length === 0}
            aria-label="New conversation"
            title="New conversation"
          >
            <Plus className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            onClick={closeAIPanel}
            aria-label="Close AI panel"
            title="Close AI panel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto px-3 py-3">
        {messages.length === 0 ? (
          <div className="h-full min-h-[180px] rounded-md border border-dashed border-border bg-muted/20 flex items-center justify-center px-4 text-center text-sm text-muted-foreground">
            Ask about the current trace.
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((message) => (
              <ChatBubble key={message.id} message={message} />
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="mx-3 mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="shrink-0 border-t border-border p-3">
        <div className="relative">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder="Ask about this trace..."
            rows={2}
            className="min-h-10 max-h-32 w-full resize-none rounded-md border border-border bg-background py-2 pl-3 pr-10 text-sm outline-none focus:border-primary/70 disabled:opacity-60"
            disabled={isLoading}
          />
          {currentConversationLoading ? (
            <button
              type="button"
              onClick={stopGeneration}
              className="absolute bottom-2 right-2 h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              aria-label="Stop"
              title="Stop"
            >
              <Square className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!input.trim() || isLoading}
              className="absolute bottom-2 right-2 h-7 w-7 inline-flex items-center justify-center rounded-md text-primary hover:bg-primary/10 disabled:text-muted-foreground disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
              aria-label="Send"
              title="Send"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
