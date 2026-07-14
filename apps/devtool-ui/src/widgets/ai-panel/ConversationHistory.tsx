import { Popover, PopoverContent, PopoverTrigger } from "@shared/ui/popover";
import { Check, Loader2, MessagesSquare, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  type AIPanelConversation,
  getConversationTitle,
  hasConversationContent,
  useAIPanelStore,
} from "./useAIPanelStore";

function conversationMeta(conversation: AIPanelConversation) {
  const userTurns = conversation.messages.filter((message) => message.role === "user").length;
  const updatedAt = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(conversation.updatedAt));
  return `${userTurns} turn${userTurns === 1 ? "" : "s"} · ${updatedAt}`;
}

export function ConversationHistory() {
  const currentConversationId = useAIPanelStore((s) => s.currentConversationId);
  const conversations = useAIPanelStore((s) => s.conversations);
  const loadingConversationId = useAIPanelStore((s) => s.loadingConversationId);
  const selectConversation = useAIPanelStore((s) => s.selectConversation);
  const deleteConversation = useAIPanelStore((s) => s.deleteConversation);
  const [open, setOpen] = useState(false);
  const historyConversations = conversations.filter(hasConversationContent);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          aria-label="Switch conversation"
          title="Switch conversation"
        >
          <MessagesSquare className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1">
        <div className="max-h-80 overflow-y-auto">
          {historyConversations.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              No conversation history.
            </div>
          )}
          {historyConversations.map((conversation) => {
            const active = conversation.id === currentConversationId;
            const running = conversation.id === loadingConversationId;
            return (
              <div
                key={conversation.id}
                className="group flex w-full min-w-0 items-start gap-1 rounded-md px-2 py-2 hover:bg-muted"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-start gap-2 text-left"
                  onClick={() => {
                    selectConversation(conversation.id);
                    setOpen(false);
                  }}
                >
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                    {running ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                    ) : active ? (
                      <Check className="h-3.5 w-3.5 text-primary" />
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-foreground">
                      {getConversationTitle(conversation)}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {conversationMeta(conversation)}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-30 group-hover:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation();
                    deleteConversation(conversation.id);
                  }}
                  disabled={running}
                  aria-label="Delete conversation"
                  title={running ? "Cannot delete running conversation" : "Delete conversation"}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
