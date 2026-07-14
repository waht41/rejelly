/**
 * WebSocket routes - real-time event broadcasting
 */

import type { TraceEvent } from "@rejelly/core";
import type {
  WsClientMessage,
  WsConnectedMessage,
  WsEventsMessage,
  WsOverviewUpdateMessage,
  WsPongMessage,
} from "@rejelly/devtool-contracts";
import type { FastifyInstance } from "fastify";
import { broadcastManager } from "../../services/broadcast.service";

/**
 * WS /ws - WebSocket endpoint for real-time updates
 *
 * Protocol:
 * Client -> Server: { type: 'subscribe', traceId?: string, topic?: 'overview' }
 * Server -> Client: { type: 'connected', traceId?: string, mode?: 'trace' | 'overview' }
 * Server -> Client: { type: 'events', events: TraceEvent[] } (detail channel)
 * Server -> Client: { type: 'overview_update', data: OverviewUpdate } (overview channel)
 */
export async function wsRoutes(fastify: FastifyInstance) {
  fastify.get("/ws", { websocket: true }, (connection, _req) => {
    const socket = connection.socket || connection;
    if (!socket) {
      fastify.log.warn("Received non-websocket request on /ws");
      return;
    }
    let clientId: string | null = null;

    // Handle client messages
    socket.on("message", (message) => {
      try {
        const data = JSON.parse(message.toString()) as Partial<WsClientMessage>;

        // Heartbeat: reply pong to ping
        if (data.type === "ping") {
          if (socket.readyState === 1) {
            const payload = { type: "pong" } satisfies WsPongMessage;
            socket.send(JSON.stringify(payload));
          }
          return;
        }

        // Handle subscription
        if (data.type === "subscribe") {
          const { traceId, topic } = data;

          // Unregister previous subscription if exists
          if (clientId) {
            broadcastManager.unregister(clientId);
          }

          // Determine subscription type
          if (topic === "overview" || traceId === "ALL") {
            // Register overview channel (global updates)
            clientId = broadcastManager.registerOverview((summaryUpdate) => {
              if (socket.readyState === 1) {
                const payload = {
                  type: "overview_update",
                  data: summaryUpdate,
                } satisfies WsOverviewUpdateMessage;
                socket.send(JSON.stringify(payload));
              }
            });

            // Send connection confirmation
            const payload = { type: "connected", mode: "overview" } satisfies WsConnectedMessage;
            socket.send(JSON.stringify(payload));
          } else {
            // Register detail channel (original logic)
            const targetTraceId = traceId || null;
            clientId = broadcastManager.register(targetTraceId, (events) => {
              // WebSocket readyState: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
              if (socket.readyState === 1) {
                const payload = { type: "events", events } satisfies WsEventsMessage<TraceEvent>;
                socket.send(JSON.stringify(payload));
              }
            });

            // Send connection confirmation
            const payload = {
              type: "connected",
              traceId: targetTraceId,
              mode: "trace",
            } satisfies WsConnectedMessage;
            socket.send(JSON.stringify(payload));
          }
        }
      } catch (e) {
        fastify.log.error(e, "WS message error");
      }
    });

    // Handle connection close
    socket.on("close", () => {
      if (clientId) {
        broadcastManager.unregister(clientId);
      }
    });

    // Handle errors
    socket.on("error", (err) => {
      fastify.log.error(err, "WS Error");
      if (clientId) {
        broadcastManager.unregister(clientId);
      }
    });
  });
}
