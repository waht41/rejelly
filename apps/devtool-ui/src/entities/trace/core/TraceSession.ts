/**
 * TraceSession – pure lifecycle for one trace: cache hydration, optional network, processor.
 * No React/Zustand; callbacks drive state updates. Reusable from Hook or non-React (e.g. Worker).
 */

import type { WsSocket } from "@entities/trace/core/adapters";
import { TraceProcessor } from "@entities/trace/core/processors/TraceProcessor";
import { addEventsToCache, getEventsFromStorage } from "@entities/trace/core/traceCache";
import type { TraceEvent } from "@rejelly/core";
import type { NormalizedTrace } from "../types";
import { NetworkAdapter } from "./adapters";

export interface TraceSessionCallbacks {
  onUpdate: (normalizedTrace: NormalizedTrace.Trace) => void;
  onError?: (err: Error) => void;
  /** Called when no cache and waiting for network */
  onLoading?: () => void;
}

/**
 * Single-trace session: hydrate from the read-through cache, then connect the
 * network adapter and push events. Processor + cache + adapter live here;
 * Hook only binds onUpdate to store.
 */
export class TraceSession {
  private processor: TraceProcessor;
  private disconnect: (() => void) | null = null;

  constructor(
    // biome-ignore lint/correctness/noUnusedPrivateClassMembers: biome error
    private readonly traceId: string,
    // biome-ignore lint/correctness/noUnusedPrivateClassMembers: biome error
    private readonly callbacks: TraceSessionCallbacks,
    private readonly socketAdapter: WsSocket,
  ) {
    this.processor = new TraceProcessor(traceId);
  }

  async start(): Promise<void> {
    const { traceId, callbacks } = this;

    const pushEvents = (events: TraceEvent[]) => {
      addEventsToCache(traceId, events);
      const { normalizedTrace, hasChanges } = this.processor.processBatch(events);
      if (!hasChanges) return;
      callbacks.onUpdate({ ...normalizedTrace });
    };

    const handleError = (err: Error) => {
      callbacks.onError?.(err);
    };

    try {
      const cachedEvents = await getEventsFromStorage(traceId);
      if (cachedEvents.length > 0) {
        pushEvents(cachedEvents);
      } else {
        callbacks.onLoading?.();
      }

      const adapter = new NetworkAdapter(this.socketAdapter);
      this.disconnect = adapter.connect(traceId, pushEvents, handleError);
    } catch (e) {
      handleError(e instanceof Error ? e : new Error(String(e)));
    }
  }

  destroy(): void {
    if (this.disconnect) {
      this.disconnect();
      this.disconnect = null;
    }
  }
}
