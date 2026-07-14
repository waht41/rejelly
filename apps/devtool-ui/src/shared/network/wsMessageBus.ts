/**
 * WebSocket message bus (Event Bus)
 *
 * Decouples raw WS messages from Zustand. High-frequency events (e.g. trace events)
 * are emitted here instead of being stored in the store, to avoid triggering
 * React re-renders for every message.
 */

import type { WsServerMessage } from "@rejelly/devtool-contracts";

const EVENT_NAME = "ws_message";

export type WSMessage = WsServerMessage;

const bus = new EventTarget();

export function emitWsMessage(data: WSMessage): void {
  bus.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: data }));
}

export function onWsMessage(handler: (data: WSMessage) => void): () => void {
  const f = (e: Event) => handler((e as CustomEvent<WSMessage>).detail as WSMessage);
  bus.addEventListener(EVENT_NAME, f);
  return () => bus.removeEventListener(EVENT_NAME, f);
}
