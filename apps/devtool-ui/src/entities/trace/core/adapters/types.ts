/**
 * Adapter interface for trace data sources
 *
 * Clean Architecture: Data Layer
 *
 * This interface abstracts away the details of how trace events are obtained.
 * It doesn't care if events come from HTTP, WebSocket, file, or mock data.
 * It only cares about: "connect to a source, then emit events"
 */

import type { TraceEvent } from "@rejelly/core";

export interface TraceAdapter {
  /**
   * Connect to data source and start emitting events
   *
   * @param traceId - The trace ID to fetch
   * @param onEvents - Callback when new events arrive (may be batched)
   * @param onError - Callback when an error occurs
   * @returns Cleanup function to disconnect/cancel requests
   */
  connect(
    traceId: string,
    onEvents: (events: TraceEvent[]) => void,
    onError: (error: Error) => void,
  ): () => void;
}
