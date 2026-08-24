import type { SessionRecorder } from "./sessionRecorder";

/**
 * Delay a brand-new session's physical creation until its first durable content event.
 *
 * Segment teardown before that boundary is intentionally a no-op: an untouched CLI launch is not
 * a durable session. Resumed sessions must not use this wrapper because they need eager locking and
 * interrupted-turn recovery.
 */
export class LazySessionRecorder implements SessionRecorder {
  readonly sessionId: string;
  readonly traceId: string;
  #recorder: SessionRecorder | undefined;
  #opening: Promise<SessionRecorder> | undefined;
  #openFailure: unknown;
  #ended = false;
  #closed = false;

  constructor(
    sessionId: string,
    traceId: string,
    private readonly openRecorder: () => Promise<SessionRecorder>,
  ) {
    this.sessionId = sessionId;
    this.traceId = traceId;
  }

  get ended(): boolean {
    return this.#recorder?.ended ?? this.#ended;
  }

  get nextImageOrdinal(): number {
    return this.#recorder?.nextImageOrdinal ?? 1;
  }

  async #ensureOpen(): Promise<SessionRecorder> {
    if (this.#closed) {
      throw new Error("Session recorder is closed");
    }
    if (this.#ended) {
      throw new Error("Session recorder segment has ended");
    }
    if (this.#openFailure) {
      throw this.#openFailure;
    }
    if (this.#recorder) {
      return this.#recorder;
    }
    this.#opening ??= this.openRecorder().then(
      (recorder) => {
        this.#recorder = recorder;
        return recorder;
      },
      (error) => {
        this.#openFailure = error;
        throw error;
      },
    );
    return this.#opening;
  }

  async recordMessage(...args: Parameters<SessionRecorder["recordMessage"]>): Promise<void> {
    await (await this.#ensureOpen()).recordMessage(...args);
  }

  async recordUserInput(...args: Parameters<SessionRecorder["recordUserInput"]>) {
    return (await this.#ensureOpen()).recordUserInput(...args);
  }

  async recordMcpSelection(
    ...args: Parameters<SessionRecorder["recordMcpSelection"]>
  ): Promise<void> {
    await (await this.#ensureOpen()).recordMcpSelection(...args);
  }

  async recordMcpToolGrants(
    ...args: Parameters<SessionRecorder["recordMcpToolGrants"]>
  ): Promise<void> {
    await (await this.#ensureOpen()).recordMcpToolGrants(...args);
  }

  async recordMessages(...args: Parameters<SessionRecorder["recordMessages"]>): Promise<void> {
    await (await this.#ensureOpen()).recordMessages(...args);
  }

  async recordCompaction(...args: Parameters<SessionRecorder["recordCompaction"]>): Promise<void> {
    await (await this.#ensureOpen()).recordCompaction(...args);
  }

  async completeTurn(...args: Parameters<SessionRecorder["completeTurn"]>): Promise<void> {
    await (await this.#ensureOpen()).completeTurn(...args);
  }

  async endSegment(...args: Parameters<SessionRecorder["endSegment"]>): Promise<void> {
    if (this.#ended) {
      return;
    }
    this.#ended = true;
    const recorder = this.#recorder ?? (await this.#opening);
    await recorder?.endSegment(...args);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const recorder = this.#recorder ?? (await this.#opening?.catch(() => undefined));
    await recorder?.close();
  }
}
