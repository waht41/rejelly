/**
 * useAppWebSocket - Global WebSocket + overview subscription
 *
 * Single hook for app-level socket: physical connection (useSocketManager) and
 * overview channel subscription (overview_update via event bus).
 * Call once at app root (e.g. AppContent). Trace-specific connection lives in useTraceConnection (AppLayout).
 * Overview handling lives here (singleton seenTraceIds) so multiple consumers don't get duplicate toasts.
 */

import { toastTrace } from "@entities/trace/lib/toastTrace";
import type { OverviewUpdate } from "@rejelly/devtool-contracts";
import { onWsMessage } from "@shared/network/wsMessageBus";
import { useSocketStore } from "@shared/store/useSocketStore";
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";

export function useAppWebSocket() {
  const navigate = useNavigate();
  const connect = useSocketStore((s) => s.connect);
  const disconnect = useSocketStore((state) => state.disconnect);
  const isConnected = useSocketStore((s) => s.isConnected);
  const send = useSocketStore((s) => s.send);
  const subscribedRef = useRef(false);
  const seenTraceIds = useRef<Set<string>>(new Set());

  const url = useSocketStore((state) => state.url);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnect when url change
  useEffect(() => {
    connect();

    return () => {
      disconnect();
    };
  }, [connect, disconnect, url]);

  // Subscribe to overview channel when connected
  useEffect(() => {
    if (isConnected && !subscribedRef.current) {
      send({ type: "subscribe", topic: "overview" });
      subscribedRef.current = true;
      console.log("[Socket] Subscribed to overview");
    } else if (!isConnected) {
      subscribedRef.current = false;
    }
  }, [isConnected, send]);

  // Handle overview_update from event bus (singleton-level dedup)
  useEffect(() => {
    const unsub = onWsMessage((msg) => {
      if (msg.type !== "overview_update" || !msg.data) return;
      const update: OverviewUpdate = msg.data;
      if (seenTraceIds.current.has(update.traceId)) return;
      seenTraceIds.current.add(update.traceId);
      toastTrace({
        traceId: update.traceId,
        onViewDetails: () => navigate(`/trace/${update.traceId}/detail`),
      });
    });
    return unsub;
  }, [navigate]);
}
