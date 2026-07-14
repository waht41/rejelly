/**
 * EnhancedWebSocket - Pure TypeScript WebSocket wrapper
 *
 * No React or Zustand. Handles: connection lifecycle, heartbeat keepalive, reconnection.
 */

import type { WsClientMessage, WsServerMessage } from "@rejelly/devtool-contracts";

export type ConnectionStatus = "connected" | "disconnected" | "connecting";

export interface WebSocketOptions {
  url: string;
  onStatusChange: (status: ConnectionStatus) => void;
  onMessage: (msg: WsServerMessage) => void;
}

export class EnhancedWebSocket {
  private ws: WebSocket | null = null;
  private options: WebSocketOptions;

  private intentionalClose = false;
  private reconnectAttempts = 0;
  private status: ConnectionStatus = "disconnected";

  private pingIntervalId: ReturnType<typeof setInterval> | null = null;
  private pongTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;

  /** Offline message queue: messages sent while disconnected are flushed on connect */
  private sendBuffer: string[] = [];

  private readonly PING_INTERVAL = 30000;
  private readonly PONG_TIMEOUT = 10000;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;

  constructor(options: WebSocketOptions) {
    this.options = options;
  }

  public connect(url?: string) {
    if (url) this.options.url = url;

    this.cleanup();
    this.intentionalClose = false;
    this.updateStatus("connecting");

    try {
      this.ws = new WebSocket(this.options.url);
      this.ws.onopen = this.handleOpen.bind(this);
      this.ws.onmessage = this.handleMessage.bind(this);
      this.ws.onclose = this.handleClose.bind(this);
      this.ws.onerror = this.handleError.bind(this);
    } catch (error) {
      console.error("[EnhancedWebSocket] Init failed:", error);
      this.triggerReconnect();
    }
  }

  public disconnect() {
    this.intentionalClose = true;
    this.cleanup();
    this.updateStatus("disconnected");
    console.log("[EnhancedWebSocket] Disconnected by user");
  }

  public send(data: WsClientMessage | string) {
    const payload = typeof data === "string" ? data : JSON.stringify(data);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
    } else {
      console.log("[EnhancedWebSocket] Not connected, buffering message...");
      this.sendBuffer.push(payload);
    }
  }

  private handleOpen() {
    console.log("[EnhancedWebSocket] Connected");
    this.reconnectAttempts = 0;
    this.updateStatus("connected");
    this.startHeartbeat();

    if (this.sendBuffer.length > 0 && this.ws) {
      console.log(`[EnhancedWebSocket] Flushing ${this.sendBuffer.length} buffered messages`);
      this.sendBuffer.forEach((msg) => {
        this.ws!.send(msg);
      });
      this.sendBuffer = [];
    }
  }

  private handleMessage(event: MessageEvent) {
    try {
      const msg = JSON.parse(event.data as string) as WsServerMessage;
      if (msg?.type === "pong") {
        this.clearPongTimeout();
        return;
      }
      this.options.onMessage(msg);
    } catch (err) {
      console.error("[EnhancedWebSocket] Parse message failed", err);
    }
  }

  private handleClose(_event: CloseEvent) {
    console.log("[EnhancedWebSocket] Connection closed");
    this.cleanup(false);
    this.updateStatus("disconnected");

    if (!this.intentionalClose) {
      this.triggerReconnect();
    }
  }

  private handleError(event: Event) {
    console.error("[EnhancedWebSocket] Error", event);
  }

  private triggerReconnect() {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.error("[EnhancedWebSocket] Max reconnect attempts reached, giving up");
      return;
    }

    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 10000);
    this.reconnectAttempts++;
    console.log(
      `[EnhancedWebSocket] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`,
    );

    if (this.reconnectTimeoutId) clearTimeout(this.reconnectTimeoutId);
    this.reconnectTimeoutId = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.pingIntervalId = setInterval(() => {
      this.send({ type: "ping" });

      this.pongTimeoutId = setTimeout(() => {
        console.warn("[EnhancedWebSocket] Heartbeat timeout, closing to trigger reconnect");
        if (this.ws) {
          this.ws.close();
        }
      }, this.PONG_TIMEOUT);
    }, this.PING_INTERVAL);
  }

  private clearPongTimeout() {
    if (this.pongTimeoutId) {
      clearTimeout(this.pongTimeoutId);
      this.pongTimeoutId = null;
    }
  }

  private stopHeartbeat() {
    if (this.pingIntervalId) clearInterval(this.pingIntervalId);
    this.pingIntervalId = null;
    this.clearPongTimeout();
  }

  private cleanup(clearReconnect = true) {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
    this.stopHeartbeat();
    if (clearReconnect && this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }
  }

  private updateStatus(newStatus: ConnectionStatus) {
    if (this.status !== newStatus) {
      this.status = newStatus;
      this.options.onStatusChange(newStatus);
    }
  }
}
