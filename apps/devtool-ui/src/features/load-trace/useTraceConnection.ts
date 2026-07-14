/**
 * Trace Connection Hook
 *
 * Thin glue: binds currentTraceId/reloadTrigger to TraceSession and store.
 * Session owns cache hydration, NetworkAdapter, TraceProcessor; this Hook only syncs results to Zustand.
 * Socket adapter is injected from app layer (IoC); feature does not depend on concrete impl.
 */

import type { WsSocket } from "@entities/trace/core/adapters";
import { TraceSession } from "@entities/trace/core/TraceSession";
import { useTraceStore } from "@entities/trace/store";
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";

export function useTraceConnection(socketAdapter: WsSocket) {
  const { currentTraceId, reloadTrigger, setNormalizedTraceData, setStatus } = useTraceStore(
    useShallow((s) => ({
      currentTraceId: s.currentTraceId,
      reloadTrigger: s.reloadTrigger,
      setNormalizedTraceData: s.setNormalizedTraceData,
      setStatus: s.setStatus,
    })),
  );

  useEffect(() => {
    const traceId = currentTraceId;
    if (!traceId) return;
    if (reloadTrigger > 0) {
      console.info(
        `[useTraceConnection] WebSocket reconnect triggered for trace: ${traceId} (Count: ${reloadTrigger})`,
      );
    }

    setStatus("connecting");

    const cancelled = { current: false };
    const session = new TraceSession(
      traceId,
      {
        onUpdate: (normalizedTrace) => {
          if (cancelled.current) return;
          setNormalizedTraceData(normalizedTrace);
          setStatus("streaming");
        },
        onError: (err) => {
          if (cancelled.current) return;
          console.error("[useTraceConnection] Session error:", err);
          setStatus("error");
        },
        onLoading: () => {
          if (cancelled.current) return;
          setStatus("loading");
        },
      },
      socketAdapter,
    );

    session.start().catch((err) => {
      if (cancelled.current) return;
      console.error("[useTraceConnection] start error:", err);
      setStatus("error");
    });

    return () => {
      cancelled.current = true;
      session.destroy();
      setNormalizedTraceData(null);
      setStatus("idle");
    };
  }, [currentTraceId, reloadTrigger, setNormalizedTraceData, setStatus, socketAdapter]);
}
