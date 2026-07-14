import { useTraceStore } from "@entities/trace/store";
import { useEffect } from "react";
import { useParams } from "react-router-dom";

/**
 * Syncs URL :traceId? with trace store and wires WebSocket-backed trace loading.
 * Shared by Detail and Waterfall route pages.
 */
export function useTraceRouteSetup() {
  const { traceId } = useParams<{ traceId?: string }>();
  const setCurrentTraceId = useTraceStore((state) => state.setCurrentTraceId);
  const closeTrace = useTraceStore((state) => state.closeTrace);
  const hasTrace = Boolean(traceId);

  useEffect(() => {
    if (hasTrace && traceId) {
      setCurrentTraceId(traceId);
      return;
    }
    closeTrace();
  }, [hasTrace, traceId, setCurrentTraceId, closeTrace]);

  return { hasTrace };
}
