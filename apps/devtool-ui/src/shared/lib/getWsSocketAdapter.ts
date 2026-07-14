/**
 * Default WsSocket implementation using store + message bus.
 * Provided by app layer (e.g. AppLayout) and injected into useTraceConnection.
 */

import { onWsMessage } from "@shared/network/wsMessageBus";
import type { WsSocket } from "@shared/type";
import { useSocketStore } from "../store/useSocketStore";

export function getWsSocketAdapter(): WsSocket {
  return {
    connect: () => useSocketStore.getState().connect(),
    send: (data) => useSocketStore.getState().send(data),
    isConnected: () => useSocketStore.getState().isConnected,
    subscribe(onMessage) {
      return onWsMessage(onMessage);
    },
  };
}
