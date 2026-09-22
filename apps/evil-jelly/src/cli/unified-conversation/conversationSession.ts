import { equipBudget, equipMemory, getUsageStats, type Message } from "@rejelly/core";
import type {
  SessionBudget,
  SessionContextTokenAnchor,
} from "../../domains/session/repository/sessionStore";
import type { EvilJellyBindings } from "../../shared/host/bindings";
import {
  createSessionMcpState,
  type SessionMcpState,
} from "../../shared/model/mcp/sessionMcpState";
import { combineSessionBudget } from "./budget";

export interface ConversationSessionSeed {
  seedContext?: Message[];
  seedBudget?: SessionBudget;
  seedContextTokenAnchor?: SessionContextTokenAnchor;
  seedMcpState?: SessionMcpState;
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
}

/** Equip the state whose lifetime is one logical interactive session segment. */
export function equipConversationSession(
  seed: ConversationSessionSeed,
  host: EvilJellyBindings,
): ConversationSession {
  const [history, setHistory] = equipMemory<Message[]>("message_history", seed.seedContext ?? []);
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

  // equipMemory getters are frozen at handler entry, so same-turn consumers use live mirrors.
  let liveContextTokens = storedContextTokens;
  let liveCacheTokens = storedCacheTokens;
  let liveRunAggregate = getUsageStats().aggregate;
  let liveSessionMcpState = storedSessionMcpState;
  let liveNextImageOrdinal = storedNextImageOrdinal;
  let liveContextTokenAnchor = storedContextTokenAnchor ?? undefined;

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
    history,
    currentBudget: () =>
      combineSessionBudget(seed.seedBudget, liveRunAggregate, {
        contextTokens: liveContextTokens,
        cacheReadTokens: liveCacheTokens,
      }),
    appendTurn: (userMessage, reply, delta) => {
      const assistantDelta =
        delta && delta.length > 0 ? delta : [{ role: "assistant" as const, content: reply }];
      setHistory([...history, userMessage, ...assistantDelta]);
    },
    replaceHistory: setHistory,
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
  };
}
