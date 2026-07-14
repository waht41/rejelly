import type { AnalyzeContext, ChatMessage } from "@entities/analyze/api";
import { createStore, del, get, set } from "idb-keyval";
import { create } from "zustand";
import { type PersistStorage, persist, type StorageValue } from "zustand/middleware";

const MAX_CONVERSATIONS = 50;
export const AI_PANEL_DEFAULT_TITLE = "AI Analysis";
const AI_PANEL_DB = "devtool-ai-panel-db";
const AI_PANEL_STORE = "conversations";
const aiPanelIdbStore = createStore(AI_PANEL_DB, AI_PANEL_STORE);

export type ChatRole = "user" | "assistant";

export type AssistantStep =
  | { id: string; type: "reasoning"; text: string }
  | { id: string; type: "tool"; name: string };

export interface PanelMessage {
  id: string;
  role: ChatRole;
  content: string;
  context?: AnalyzeContext;
  steps?: AssistantStep[];
  status?: "running" | "completed" | "error";
}

export interface AIPanelConversation {
  id: string;
  title?: string;
  titleEdited?: boolean;
  messages: PanelMessage[];
  history: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

interface AIPanelState {
  currentConversationId: string;
  conversations: AIPanelConversation[];
  input: string;
  isLoading: boolean;
  loadingConversationId: string | null;
  error: string | null;
  setInput: (input: string) => void;
  setLoading: (isLoading: boolean, conversationId?: string | null) => void;
  setError: (error: string | null) => void;
  appendMessages: (messages: PanelMessage[]) => void;
  appendMessagesToConversation: (conversationId: string, messages: PanelMessage[]) => void;
  updateMessages: (updater: (messages: PanelMessage[]) => PanelMessage[]) => void;
  updateConversationMessages: (
    conversationId: string,
    updater: (messages: PanelMessage[]) => PanelMessage[],
  ) => void;
  appendHistory: (entries: ChatMessage[]) => void;
  appendConversationHistory: (conversationId: string, entries: ChatMessage[]) => void;
  selectConversation: (conversationId: string) => void;
  deleteConversation: (conversationId: string) => void;
  renameConversation: (conversationId: string, title: string) => void;
  setConversationTitleFromPrompt: (conversationId: string, prompt: string) => void;
  createNewConversation: () => void;
}

type PersistedAIPanelState = Pick<AIPanelState, "currentConversationId" | "conversations">;

let pendingPersistValue: StorageValue<PersistedAIPanelState> | null = null;
let pendingPersistName: string | null = null;
let pendingPersistTimer: ReturnType<typeof setTimeout> | null = null;
let lastPersistSignature: string | null = null;

function createPersistSignature(value: StorageValue<PersistedAIPanelState>) {
  return [
    value.version ?? 0,
    value.state.currentConversationId,
    ...value.state.conversations.map((conversation) =>
      [
        conversation.id,
        conversation.updatedAt,
        conversation.title ?? "",
        conversation.titleEdited ? 1 : 0,
        conversation.messages.length,
        conversation.history.length,
      ].join(":"),
    ),
  ].join("|");
}

function flushPendingPersistValue(name: string) {
  if (!pendingPersistValue) return;
  const value = pendingPersistValue;
  pendingPersistValue = null;
  pendingPersistName = null;
  pendingPersistTimer = null;
  void set(name, value, aiPanelIdbStore).catch((error) => {
    console.error("Failed to persist AI panel conversations", error);
  });
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    if (pendingPersistName) flushPendingPersistValue(pendingPersistName);
  });
}

const aiPanelPersistStorage: PersistStorage<PersistedAIPanelState> = {
  getItem: async (name) => {
    if (pendingPersistValue) return pendingPersistValue;
    const value = (await get<StorageValue<PersistedAIPanelState>>(name, aiPanelIdbStore)) ?? null;
    lastPersistSignature = value ? createPersistSignature(value) : null;
    return value;
  },
  setItem: (name, value) => {
    const nextSignature = createPersistSignature(value);
    if (nextSignature === lastPersistSignature) return;
    lastPersistSignature = nextSignature;
    pendingPersistValue = value;
    pendingPersistName = name;
    if (pendingPersistTimer) {
      clearTimeout(pendingPersistTimer);
    }
    pendingPersistTimer = setTimeout(() => flushPendingPersistValue(name), 250);
  },
  removeItem: (name) => {
    pendingPersistValue = null;
    pendingPersistName = null;
    lastPersistSignature = null;
    if (pendingPersistTimer) {
      clearTimeout(pendingPersistTimer);
      pendingPersistTimer = null;
    }
    return del(name, aiPanelIdbStore);
  },
};

function createMessageId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createAnalyzeConversationId() {
  return `analyze-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createPanelMessageId() {
  return createMessageId();
}

export function truncateConversationTitle(value: string) {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 20 ? normalized.slice(0, 20) : normalized;
}

export function getConversationTitle(
  conversation: Pick<AIPanelConversation, "title" | "messages">,
) {
  const storedTitle = conversation.title?.trim();
  if (storedTitle) return storedTitle;
  const firstUserMessage = conversation.messages.find((message) => message.role === "user");
  if (firstUserMessage) return truncateConversationTitle(firstUserMessage.content);
  return AI_PANEL_DEFAULT_TITLE;
}

function createConversation(id = createAnalyzeConversationId()): AIPanelConversation {
  const now = Date.now();
  return {
    id,
    title: AI_PANEL_DEFAULT_TITLE,
    titleEdited: false,
    messages: [],
    history: [],
    createdAt: now,
    updatedAt: now,
  };
}

function keepNonEmpty(conversations: AIPanelConversation[]) {
  return conversations.filter((conversation) => hasConversationContent(conversation));
}

export function hasConversationContent(conversation: AIPanelConversation) {
  return conversation.messages.length > 0 || conversation.history.length > 0;
}

function putConversation(conversations: AIPanelConversation[], conversation: AIPanelConversation) {
  return [conversation, ...conversations.filter((item) => item.id !== conversation.id)].slice(
    0,
    MAX_CONVERSATIONS,
  );
}

function normalizePersistedConversation(conversation: AIPanelConversation): AIPanelConversation {
  return {
    ...conversation,
    messages: conversation.messages.map((message) =>
      message.status === "running"
        ? {
            ...message,
            status: "completed",
            content: message.content || "Stopped.",
          }
        : message,
    ),
  };
}

function updateCurrentConversation(
  state: AIPanelState,
  updater: (conversation: AIPanelConversation) => AIPanelConversation,
) {
  return updateConversation(state, state.currentConversationId, updater);
}

function updateConversation(
  state: AIPanelState,
  conversationId: string,
  updater: (conversation: AIPanelConversation) => AIPanelConversation,
) {
  const existing =
    state.conversations.find((conversation) => conversation.id === conversationId) ??
    createConversation(conversationId);
  const updated = updater(existing);
  return {
    conversations: putConversation(state.conversations, {
      ...updated,
      updatedAt: Date.now(),
    }),
  };
}

const initialConversation = createConversation();

export const useAIPanelStore = create<AIPanelState>()(
  persist(
    (set) => ({
      currentConversationId: initialConversation.id,
      conversations: [initialConversation],
      input: "",
      isLoading: false,
      loadingConversationId: null,
      error: null,

      setInput: (input) => set({ input }),
      setLoading: (isLoading, conversationId) =>
        set((state) => ({
          isLoading,
          loadingConversationId: isLoading ? (conversationId ?? state.currentConversationId) : null,
        })),
      setError: (error) => set({ error }),

      appendMessages: (messages) =>
        set((state) =>
          updateCurrentConversation(state, (conversation) => ({
            ...conversation,
            messages: [...conversation.messages, ...messages],
          })),
        ),

      appendMessagesToConversation: (conversationId, messages) =>
        set((state) =>
          updateConversation(state, conversationId, (conversation) => ({
            ...conversation,
            messages: [...conversation.messages, ...messages],
          })),
        ),

      updateMessages: (updater) =>
        set((state) =>
          updateCurrentConversation(state, (conversation) => ({
            ...conversation,
            messages: updater(conversation.messages),
          })),
        ),

      updateConversationMessages: (conversationId, updater) =>
        set((state) =>
          updateConversation(state, conversationId, (conversation) => ({
            ...conversation,
            messages: updater(conversation.messages),
          })),
        ),

      appendHistory: (entries) =>
        set((state) =>
          updateCurrentConversation(state, (conversation) => ({
            ...conversation,
            history: [...conversation.history, ...entries],
          })),
        ),

      appendConversationHistory: (conversationId, entries) =>
        set((state) =>
          updateConversation(state, conversationId, (conversation) => ({
            ...conversation,
            history: [...conversation.history, ...entries],
          })),
        ),

      selectConversation: (conversationId) =>
        set((state) => {
          const conversation = state.conversations.find((item) => item.id === conversationId);
          if (!conversation) return {};
          return {
            currentConversationId: conversationId,
            conversations: putConversation(state.conversations, conversation),
            input: "",
            error: null,
          };
        }),

      deleteConversation: (conversationId) =>
        set((state) => {
          const conversations = state.conversations.filter((item) => item.id !== conversationId);
          const nextConversations =
            conversations.length > 0 ? conversations : [createConversation()];
          const nextCurrentConversation =
            nextConversations.find(hasConversationContent) ?? nextConversations[0];
          const currentConversationId =
            state.currentConversationId === conversationId
              ? nextCurrentConversation.id
              : state.currentConversationId;
          return {
            currentConversationId,
            conversations: nextConversations,
            input: state.currentConversationId === conversationId ? "" : state.input,
            isLoading: state.loadingConversationId === conversationId ? false : state.isLoading,
            loadingConversationId:
              state.loadingConversationId === conversationId ? null : state.loadingConversationId,
            error: state.currentConversationId === conversationId ? null : state.error,
          };
        }),

      renameConversation: (conversationId, title) =>
        set((state) =>
          updateConversation(state, conversationId, (conversation) => ({
            ...conversation,
            title: title.trim().replace(/\s+/g, " ") || AI_PANEL_DEFAULT_TITLE,
            titleEdited: true,
          })),
        ),

      setConversationTitleFromPrompt: (conversationId, prompt) =>
        set((state) =>
          updateConversation(state, conversationId, (conversation) => {
            if (conversation.titleEdited) return conversation;
            const hasUserMessage = conversation.messages.some((message) => message.role === "user");
            if (hasUserMessage) return conversation;
            return {
              ...conversation,
              title: truncateConversationTitle(prompt) || AI_PANEL_DEFAULT_TITLE,
            };
          }),
        ),

      createNewConversation: () =>
        set((state) => {
          const next = createConversation();
          return {
            currentConversationId: next.id,
            conversations: [next, ...keepNonEmpty(state.conversations)].slice(0, MAX_CONVERSATIONS),
            input: "",
            isLoading: false,
            loadingConversationId: null,
            error: null,
          };
        }),
    }),
    {
      name: "devtool-ai-panel-conversations",
      storage: aiPanelPersistStorage,
      version: 1,
      migrate: (state) => state as PersistedAIPanelState,
      partialize: (state) => ({
        currentConversationId: state.currentConversationId,
        conversations: state.conversations.slice(0, MAX_CONVERSATIONS),
      }),
      merge: (persisted, current) => {
        const persistedState = persisted as Partial<AIPanelState> | undefined;
        const persistedConversations = persistedState?.conversations
          ?.slice(0, MAX_CONVERSATIONS)
          .map(normalizePersistedConversation);
        const conversations =
          persistedConversations && persistedConversations.length > 0
            ? persistedConversations
            : current.conversations;
        const currentConversationId =
          persistedState?.currentConversationId &&
          conversations.some((item) => item.id === persistedState.currentConversationId)
            ? persistedState.currentConversationId
            : (conversations[0]?.id ?? current.currentConversationId);

        return {
          ...current,
          currentConversationId,
          conversations,
          input: current.input,
          isLoading: false,
          loadingConversationId: null,
          error: null,
        };
      },
    },
  ),
);
