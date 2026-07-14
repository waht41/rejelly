import { createDeferred, type Deferred } from "./deferred";

interface DispatcherClosedState {
  closed: boolean;
  error?: unknown;
}

export interface StreamEventSubscriptionOptions {
  signal?: AbortSignal;
}

/**
 * Append-only async event dispatcher with replay and multicast support.
 *
 * Each subscriber reads from the same event log with its own cursor.
 * No polling is used: subscribers suspend on a Deferred and producers wake them
 * when new events arrive or when the dispatcher closes.
 */
export class StreamEventDispatcher<T> {
  private readonly events: T[] = [];
  private readonly waiters = new Set<Deferred<void>>();
  private readonly state: DispatcherClosedState = { closed: false };

  append(event: T): void {
    if (this.state.closed) {
      throw new Error("Cannot append to a closed StreamEventDispatcher");
    }

    this.events.push(event);
    this.flushWaiters();
  }

  close(error?: unknown): void {
    if (this.state.closed) return;

    this.state.closed = true;
    this.state.error = error;
    this.flushWaiters();
  }

  subscribe(startIndex = 0, options?: StreamEventSubscriptionOptions): AsyncGenerator<T> {
    return this.consume(startIndex, options);
  }

  get size(): number {
    return this.events.length;
  }

  get closed(): boolean {
    return this.state.closed;
  }

  private flushWaiters(): void {
    if (this.waiters.size === 0) return;

    const currentWaiters = Array.from(this.waiters);
    this.waiters.clear();

    for (const waiter of currentWaiters) {
      waiter.resolve();
    }
  }

  private async *consume(
    startIndex: number,
    options?: StreamEventSubscriptionOptions,
  ): AsyncGenerator<T> {
    let cursor = Math.max(0, startIndex);
    const signal = options?.signal;

    while (true) {
      while (cursor < this.events.length) {
        yield this.events[cursor];
        cursor++;
      }

      if (signal?.aborted) {
        return;
      }

      if (this.state.closed) {
        if (this.state.error !== undefined) {
          throw this.state.error;
        }
        return;
      }

      const waiter = createDeferred<void>();
      this.waiters.add(waiter);
      const abortWaiter = () => waiter.resolve();
      signal?.addEventListener("abort", abortWaiter, { once: true });

      try {
        await waiter.promise;
      } finally {
        signal?.removeEventListener("abort", abortWaiter);
        this.waiters.delete(waiter);
      }
    }
  }
}
