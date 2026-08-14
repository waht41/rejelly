import { drainToolOutput, type ToolOutputDrain } from "./tailWindow";

const DEFAULT_FLUSH_INTERVAL_MS = 50;

/** Batches high-frequency raw tool chunks before the transaction store updates live rows. */
export class RunningToolOutputBuffer {
  private readonly pending = new Map<string, string>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly onFlush: (drained: ReadonlyMap<string, ToolOutputDrain>) => void,
    private readonly flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
  ) {}

  append(toolCallId: string, chunk: string): void {
    if (chunk.length === 0) {
      return;
    }
    this.pending.set(toolCallId, (this.pending.get(toolCallId) ?? "") + chunk);
    if (this.flushTimer === undefined) {
      this.flushTimer = setTimeout(() => this.flush(), this.flushIntervalMs);
    }
  }

  flush(): void {
    this.clearTimer();
    if (this.pending.size === 0) {
      return;
    }
    const drained = new Map<string, ToolOutputDrain>();
    for (const [id, buffer] of this.pending) {
      const result = drainToolOutput(buffer);
      drained.set(id, result);
      this.pending.set(id, result.rest);
    }
    this.onFlush(drained);
  }

  discard(toolCallId: string): void {
    this.pending.delete(toolCallId);
  }

  reset(): void {
    this.clearTimer();
    this.pending.clear();
  }

  private clearTimer(): void {
    if (this.flushTimer === undefined) {
      return;
    }
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }
}
