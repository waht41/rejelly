/**
 * Socket abstraction for NetworkAdapter (dependency injection).
 * Implemented at app layer using store + wsMessageBus; keeps adapter free of React/Zustand.
 */
import type { WsClientMessage, WsServerMessage } from "@rejelly/devtool-contracts";

export interface WsSocket {
  connect(): void;

  send(data: WsClientMessage): void;

  isConnected(): boolean;

  /**
   * Subscribe to raw WS messages. Consumer is responsible for filtering by type/channel.
   * @param onMessage - Callback for each message from WS.
   * @returns Unsubscribe function.
   */
  subscribe(onMessage: (msg: WsServerMessage) => void): () => void;
}
