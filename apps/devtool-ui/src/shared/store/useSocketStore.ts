/**
 * Socket Store - Bridge between UI and EnhancedWebSocket
 *
 * Holds connection state and delegates connect/disconnect/send to a single
 * EnhancedWebSocket instance. Messages are forwarded to the event bus (wsMessageBus).
 */

import type { WsClientMessage } from "@rejelly/devtool-contracts";
import { type ConnectionStatus, EnhancedWebSocket } from "@shared/network/EnhancedWebSocket";
import { emitWsMessage } from "@shared/network/wsMessageBus";
import { create } from "zustand";
import { getDefaultWebSocketUrl } from "../lib/getUrl";

export type { ConnectionStatus };

interface SocketState {
  url: string;
  status: ConnectionStatus;
  isConnected: boolean;
  _wsInstance: InstanceType<typeof EnhancedWebSocket> | null;

  connect: (url?: string) => void;
  disconnect: () => void;
  send: (data: WsClientMessage) => void;
  setUrl: (url: string) => void;
}

export const useSocketStore = create<SocketState>((set, get) => ({
  url: getDefaultWebSocketUrl(),
  status: "disconnected",
  isConnected: false,
  _wsInstance: null,

  connect: (url) => {
    // Idempotent: ignore duplicate connect while already connected or in flight
    const { isConnected, status } = get();
    if (isConnected || status === "connecting") return;

    const targetUrl = url ?? get().url;

    let ws = get()._wsInstance;
    if (!ws) {
      ws = new EnhancedWebSocket({
        url: targetUrl,
        onStatusChange: (status) => {
          set({ status, isConnected: status === "connected" });
        },
        onMessage: (msg) => {
          emitWsMessage(msg);
        },
      });
      set({ _wsInstance: ws, url: targetUrl });
    }

    ws.connect(targetUrl);
  },

  disconnect: () => {
    const ws = get()._wsInstance;
    if (ws) {
      ws.disconnect();
    }
  },

  send: (data) => {
    const ws = get()._wsInstance;
    if (ws) {
      ws.send(data);
    } else {
      console.warn("[SocketStore] Cannot send: no socket instance");
    }
  },

  setUrl: (url: string) => {
    set({ url });
    const { status, _wsInstance } = get();
    if (_wsInstance && (status === "connected" || status === "connecting")) {
      _wsInstance.connect(url);
    }
  },
}));
