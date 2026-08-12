import { StreamStableTailController } from "./stableTail";

const DEFAULT_TRANSIENT_CAP = 96_000;
const DEFAULT_FLUSH_INTERVAL_MS = 50;

export interface AssistantStreamFlush {
  stableText: string;
  tailText: string;
}

/**
 * Owns delta batching, Markdown holdback, and the bounded transient tail.
 * Persistent history and runtime status stay with the caller so a flush updates them atomically.
 */
export class AssistantStreamBuffer {
  private pendingText = "";
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly stableTail = new StreamStableTailController();

  constructor(
    private readonly onFlush: (flush: AssistantStreamFlush) => void,
    private readonly options: { flushIntervalMs?: number; transientCap?: number } = {},
  ) {}

  append(text: string): void {
    this.pendingText += text;
    if (this.flushTimer === undefined) {
      this.flushTimer = setTimeout(
        () => this.flush(),
        this.options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      );
    }
  }

  flush(): void {
    if (this.pendingText.length === 0) {
      this.clearFlushTimer();
      return;
    }
    const text = this.pendingText;
    this.pendingText = "";
    this.clearFlushTimer();
    const partition = this.stableTail.push(text);
    this.onFlush({
      stableText: partition.stableText,
      tailText: capTail(partition.tailText, this.options.transientCap ?? DEFAULT_TRANSIENT_CAP),
    });
  }

  /** Commit batched deltas, then release the Markdown holdback before an interruption. */
  drain(): string {
    this.flush();
    return this.stableTail.drain();
  }

  /** Reconcile the incremental source with the model's final assistant message. */
  finalize(finalContent: string): { visualRemainder: string; shouldHideFinal: boolean } {
    this.flush();
    return this.stableTail.finalize(finalContent);
  }

  reset(): void {
    this.pendingText = "";
    this.clearFlushTimer();
    this.stableTail.reset();
  }

  private clearFlushTimer(): void {
    if (this.flushTimer === undefined) {
      return;
    }
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }
}

function capTail(value: string, cap: number): string {
  return value.length <= cap ? value : value.slice(-cap);
}
