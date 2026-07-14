import { Mutex } from "async-mutex";

/**
 * FIFO-bounded cache of per-traceId mutexes.
 * Prevents unbounded memory growth when processing many traces (e.g. eval batches).
 */
export class TraceMutexCache {
  private map = new Map<string, Mutex>();
  private keys: string[] = [];
  private readonly MAX_SIZE = 1000;

  getMutex(traceId: string): Mutex {
    let mutex = this.map.get(traceId);
    if (!mutex) {
      mutex = new Mutex();
      this.map.set(traceId, mutex);
      this.keys.push(traceId);

      if (this.keys.length > this.MAX_SIZE) {
        const oldestTraceId = this.keys.shift()!;
        this.map.delete(oldestTraceId);
      }
    }
    return mutex;
  }
}
