/**
 * Network adapter for fetching trace events from server
 *
 * Handles:
 * 1. Loading historical events via REST API
 * 2. Subscribing to real-time events via WebSocket
 *
 * REST + WS coordination: Start WS subscription first (buffer incoming events),
 * then run REST. After REST resolves, deliver REST result then flush buffer, then stream WS.
 *
 * Gap-fill: Events that occur between first REST response and WS subscribe ack can be missed.
 * When the server sends subscribe success ({ type: 'connected', traceId, mode: 'trace' }),
 * we run a second REST fetch and deliver those events. Processors are idempotent (nodeMap keyed by spanId),
 * so duplicate events are safe.
 * No dependency on Zustand; socket is injected (WsSocket).
 */

import { fetchTraceEvents } from "@entities/trace/api";
import type { TraceEvent } from "@rejelly/core";
import type { WsServerMessage } from "@rejelly/devtool-contracts";
import type { WsSocket } from "@shared/type";
import type { TraceAdapter } from "./types";

export class NetworkAdapter implements TraceAdapter {
  constructor(private readonly socket: WsSocket) {}

  connect(
    traceId: string,
    onEvents: (events: TraceEvent[]) => void,
    onError: (error: Error) => void,
  ): () => void {
    const ac = new AbortController();

    // Buffer for WS events that arrive while REST is in flight
    const buffer: TraceEvent[] = [];
    let restSettled = false;

    const flushBuffer = () => {
      if (buffer.length > 0) {
        onEvents([...buffer]);
        buffer.length = 0;
      }
    };

    const handleWsEvents = (events: TraceEvent[]) => {
      if (restSettled) {
        onEvents(events);
      } else {
        buffer.push(...events);
      }
    };

    // When server confirms subscribe (type 'connected'), re-fetch REST to cover gap between first REST and WS stream
    let subscribedFired = false;
    const onSubscribed = () => {
      fetchTraceEvents(traceId, ac.signal)
        .then((events) => {
          if (ac.signal.aborted) return;
          if (events.length > 0) onEvents(events);
        })
        .catch((err) => {
          if (err.name !== "AbortError" && !ac.signal.aborted) {
            onError(err instanceof Error ? err : new Error(String(err)));
          }
        });
    };

    const unsubWs = this.socket.subscribe((m: WsServerMessage<TraceEvent>) => {
      if (m.type === "connected" && m.traceId === traceId && m.mode === "trace") {
        if (!subscribedFired) {
          subscribedFired = true;
          onSubscribed();
        }
        return;
      }
      if (m.type === "events" && Array.isArray(m.events)) {
        const filtered = m.events.filter((e) => e.trace.traceId === traceId);
        if (filtered.length > 0) handleWsEvents(filtered);
      }
    });

    // 1. Connect if needed; subscribe immediately (sendBuffer in EnhancedWebSocket queues if not connected, flushes on open)
    if (!this.socket.isConnected()) {
      this.socket.connect();
    }
    this.socket.send({ type: "subscribe", traceId });

    // 2. REST: load baseline, then flush buffer and mark rest as settled
    fetchTraceEvents(traceId, ac.signal)
      .then((events) => {
        if (ac.signal.aborted) return;
        restSettled = true;
        if (events.length > 0) {
          onEvents(events);
        }
        flushBuffer();
      })
      .catch((err) => {
        if (err.name !== "AbortError" && !ac.signal.aborted) {
          onError(err instanceof Error ? err : new Error(String(err)));
        }
        restSettled = true;
        flushBuffer();
      });

    return () => {
      ac.abort();
      unsubWs();
      if (this.socket.isConnected()) {
        this.socket.send({ type: "unsubscribe", traceId });
      }
    };
  }
}
