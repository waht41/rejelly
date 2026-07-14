/**
 * Broadcast service - manages WebSocket event broadcasting to connected clients
 *
 * Dual Channel Architecture:
 * - Detail Channel: Subscribe to specific traceId, receive full events
 * - Overview Channel: Subscribe to global updates, receive lightweight summaries
 */

import type { TraceEvent } from "@rejelly/core";
import type { OverviewUpdate } from "@rejelly/devtool-contracts";

type ClientId = string;

interface Client {
  id: ClientId;
  traceId: string | null; // null means subscribe to all traces
  send: (event: TraceEvent[]) => void;
}

type TraceListener = (events: TraceEvent[]) => void;
type OverviewListener = (update: OverviewUpdate) => void;

class BroadcastManager {
  // Detail channel: trace-specific subscriptions
  private clients: Map<ClientId, Client> = new Map();

  // Overview channel: global summary subscriptions
  private overviewListeners: Map<ClientId, OverviewListener> = new Map();

  private clientIdCounter = 0;

  /**
   * Register a new client for detail channel (specific trace)
   */
  register(traceId: string | null, send: TraceListener): ClientId {
    const id = `client-${++this.clientIdCounter}`;
    this.clients.set(id, { id, traceId, send });
    return id;
  }

  /**
   * Register a new client for overview channel (global updates)
   */
  registerOverview(cb: OverviewListener): ClientId {
    const id = `client-${++this.clientIdCounter}`;
    this.overviewListeners.set(id, cb);
    return id;
  }

  /**
   * Unregister a client (cleans up both channels)
   */
  unregister(clientId: ClientId): void {
    this.clients.delete(clientId);
    this.overviewListeners.delete(clientId);
  }

  /**
   * Broadcast events to detail channel clients
   */
  broadcast(traceId: string, events: TraceEvent[]): void {
    for (const client of this.clients.values()) {
      // Send to clients subscribed to this trace or all traces
      if (client.traceId === null || client.traceId === traceId) {
        try {
          client.send(events);
        } catch (error) {
          console.error(`[Broadcast] Failed to send to client ${client.id}:`, error);
          // Remove failed client
          this.clients.delete(client.id);
        }
      }
    }
  }

  /**
   * Broadcast overview update to overview channel clients
   */
  broadcastOverview(update: OverviewUpdate): void {
    for (const listener of this.overviewListeners.values()) {
      try {
        listener(update);
      } catch (error) {
        console.error(`[Broadcast] Failed to send overview update:`, error);
      }
    }
  }

  /**
   * Get client count (for debugging)
   */
  getClientCount(): number {
    return this.clients.size + this.overviewListeners.size;
  }
}

// Singleton instance
export const broadcastManager = new BroadcastManager();
