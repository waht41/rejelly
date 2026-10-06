import { equipBudget, equipMemory, getUsageStats, type Message } from "@rejelly/core";
import { normalizeMessages } from "@rejelly/core/policy";
import {
  getSessionImageBlobMetadata,
  registerRuntimeSessionImageBlobs,
  type SessionImageBlobMap,
} from "../../domains/session/model/storedSessionMessage";
import type {
  SessionBudget,
  SessionContextTokenAnchor,
} from "../../domains/session/repository/sessionStore";
import type { EvilJellyBindings } from "../../shared/host/bindings";
import {
  createSessionMcpState,
  type SessionMcpState,
} from "../../shared/model/mcp/sessionMcpState";
import {
  type FrozenUserInputV1,
  getFrozenUserInputOrigin,
  registerFrozenUserInputOrigin,
} from "../../shared/model/prompt/frozenUserInput";
import { combineSessionBudget } from "./budget";
import type { TurnRecoveryState } from "./turnRecovery";

export interface ConversationSessionSeed {
  seedContext?: Message[];
  seedBudget?: SessionBudget;
  seedContextTokenAnchor?: SessionContextTokenAnchor;
  seedMcpState?: SessionMcpState;
  seedRecovery?: TurnRecoveryState;
  initialImageOrdinal?: number;
}

/** Live session state carried across MainCliAgent reborns within one run segment. */
export interface ConversationSession {
  readonly history: Message[];
  currentBudget: () => SessionBudget;
  appendTurn: (userMessage: Message, reply: string, delta?: Message[]) => void;
  replaceHistory: (messages: Message[]) => void;
  mcpState: () => SessionMcpState;
  setMcpState: (state: SessionMcpState) => void;
  nextImageOrdinal: () => number;
  setNextImageOrdinal: (ordinal: number) => void;
  contextTokenAnchor: () => SessionContextTokenAnchor | undefined;
  clearContextTokenAnchor: () => void;
  clearLastContextUsage: () => void;
  recoveryState: () => TurnRecoveryState | undefined;
  setRecoveryState: (state: TurnRecoveryState) => void;
  clearRecoveryState: () => void;
  ensureHistoryIncludes: (message: Message) => void;
}

// equipMemory JSON-clones values, so WeakMap associations must cross this boundary explicitly.
// Keep them beside the message rather than adding internal metadata to its provider wire shape.
interface MessageSnapshot {
  message: Message;
  imageBlobs: SessionImageBlobMap;
  origin?: FrozenUserInputV1;
}

type RecoverySnapshot = Omit<TurnRecoveryState, "userMessage" | "retryHistory"> & {
  userMessage: MessageSnapshot;
  retryHistory?: MessageSnapshot[];
};

function snapshotMessage(message: Message): MessageSnapshot {
  const origin = getFrozenUserInputOrigin(message);
  return {
    message,
    imageBlobs: getSessionImageBlobMetadata(message),
    ...(origin ? { origin } : {}),
  };
}

function restoreMessage(snapshot: MessageSnapshot): Message {
  const message = registerRuntimeSessionImageBlobs(snapshot.message, snapshot.imageBlobs);
  return snapshot.origin ? registerFrozenUserInputOrigin(message, snapshot.origin) : message;
}

function snapshotRecovery(state: TurnRecoveryState): RecoverySnapshot {
  const { userMessage, retryHistory, ...rest } = state;
  return {
    ...rest,
    userMessage: snapshotMessage(userMessage),
    ...(retryHistory ? { retryHistory: retryHistory.map(snapshotMessage) } : {}),
  };
}

function restoreRecovery(snapshot: RecoverySnapshot): TurnRecoveryState {
  const { userMessage, retryHistory, ...rest } = snapshot;
  return {
    ...rest,
    userMessage: restoreMessage(userMessage),
    ...(retryHistory ? { retryHistory: retryHistory.map(restoreMessage) } : {}),
  };
}

/** Equip the state whose lifetime is one logical interactive session segment. */
export function equipConversationSession(
  seed: ConversationSessionSeed,
  host: EvilJellyBindings,
): ConversationSession {
  const [history, setHistory] = equipMemory<MessageSnapshot[]>(
    "message_history",
    (seed.seedContext ?? []).map(snapshotMessage),
  );
  const [storedContextTokens, setLastContextTokens] = equipMemory<number>(
    "main_cli:last_context_tokens",
    seed.seedBudget?.lastContextTokens ?? 0,
  );
  const [storedCacheTokens, setLastCacheTokens] = equipMemory<number>(
    "main_cli:last_cache_tokens",
    seed.seedBudget?.lastCacheReadTokens ?? 0,
  );
  const [storedSessionMcpState, storeSessionMcpState] = equipMemory<SessionMcpState>(
    "main_cli:mcp_state",
    seed.seedMcpState ?? createSessionMcpState(),
  );
  const [storedNextImageOrdinal, storeNextImageOrdinal] = equipMemory<number>(
    "main_cli:next_image_ordinal",
    seed.initialImageOrdinal ?? 1,
  );
  const [storedContextTokenAnchor, storeContextTokenAnchor] =
    equipMemory<SessionContextTokenAnchor | null>(
      "main_cli:context_token_anchor",
      seed.seedContextTokenAnchor ?? null,
    );
  const [storedRecoveryState, storeRecoveryState] = equipMemory<RecoverySnapshot | null>(
    "main_cli:turn_recovery",
    seed.seedRecovery ? snapshotRecovery(seed.seedRecovery) : null,
  );

  // equipMemory getters are frozen at handler entry, so same-turn consumers use live mirrors.
  let liveHistory = history.map(restoreMessage);
  let liveContextTokens = storedContextTokens;
  let liveCacheTokens = storedCacheTokens;
  let liveRunAggregate = getUsageStats().aggregate;
  let liveSessionMcpState = storedSessionMcpState;
  let liveNextImageOrdinal = storedNextImageOrdinal;
  let liveContextTokenAnchor = storedContextTokenAnchor ?? undefined;
  let liveRecoveryState = storedRecoveryState ? restoreRecovery(storedRecoveryState) : undefined;

  equipBudget({
    onUpdate: ({ delta, aggregate }) => {
      liveRunAggregate = aggregate;
      if (delta.promptTokens > 0 && delta.items.some((item) => item.type === "model")) {
        liveContextTokens = delta.promptTokens;
        setLastContextTokens(delta.promptTokens);
        liveCacheTokens = delta.details?.cacheReadTokens ?? 0;
        setLastCacheTokens(liveCacheTokens);
      }
    },
  });

  const setNextImageOrdinal = (ordinal: number) => {
    liveNextImageOrdinal = ordinal;
    storeNextImageOrdinal(ordinal);
    host.setNextImageOrdinal?.(ordinal);
  };
  host.setNextImageOrdinal?.(liveNextImageOrdinal);

  return {
    get history() {
      return liveHistory;
    },
    currentBudget: () =>
      combineSessionBudget(seed.seedBudget, liveRunAggregate, {
        contextTokens: liveContextTokens,
        cacheReadTokens: liveCacheTokens,
      }),
    appendTurn: (userMessage, reply, delta) => {
      const assistantDelta =
        delta && delta.length > 0 ? delta : [{ role: "assistant" as const, content: reply }];
      liveHistory = [...liveHistory, userMessage, ...assistantDelta];
      setHistory(liveHistory.map(snapshotMessage));
    },
    replaceHistory: (messages) => {
      liveHistory = messages;
      setHistory(messages.map(snapshotMessage));
    },
    mcpState: () => liveSessionMcpState,
    setMcpState: (state) => {
      liveSessionMcpState = state;
      storeSessionMcpState(state);
    },
    nextImageOrdinal: () => liveNextImageOrdinal,
    setNextImageOrdinal,
    contextTokenAnchor: () => liveContextTokenAnchor,
    clearContextTokenAnchor: () => {
      liveContextTokenAnchor = undefined;
      storeContextTokenAnchor(null);
    },
    clearLastContextUsage: () => {
      liveContextTokens = 0;
      liveCacheTokens = 0;
      setLastContextTokens(0);
      setLastCacheTokens(0);
    },
    recoveryState: () => liveRecoveryState,
    setRecoveryState: (state) => {
      liveRecoveryState = state;
      storeRecoveryState(snapshotRecovery(state));
    },
    clearRecoveryState: () => {
      liveRecoveryState = undefined;
      storeRecoveryState(null);
    },
    ensureHistoryIncludes: (message) => {
      // Model policy normalizes user text to content parts. Compare the same representation
      // so recovery does not append a second copy of an already committed user input.
      const serialize = (candidate: Message) =>
        JSON.stringify(candidate.role === "user" ? normalizeMessages([candidate])[0] : candidate);
      const serialized = serialize(message);
      if (liveHistory.some((candidate) => serialize(candidate) === serialized)) return;
      liveHistory = [...liveHistory, message];
      setHistory(liveHistory.map(snapshotMessage));
    },
  };
}
