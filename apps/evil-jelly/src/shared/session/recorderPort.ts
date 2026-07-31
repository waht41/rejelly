/**
 * The write surface the agent loop needs from a durable session recorder.
 *
 * The concrete recorder (`services/session/sessionRecorder`) implements this plus turn/segment
 * lifecycle, which only the shell drives. Callers below the shell — the policy layer, agent props —
 * depend on this narrow port instead, so they never reach into the session service.
 *
 * Each method resolves only after its complete batch has reached the file's durable boundary.
 * Callers must pass only immutable, completed messages.
 */

import type { Message } from "@rejelly/core";
import type { MessageSource } from "./messageSource";

export interface SessionCompactionRecord {
  trigger: "auto" | "manual";
  activeTurnId?: string;
  replacementHistory: Message[];
  beforeMessageCount: number;
  beforeTokens?: number;
  afterTokens?: number;
  keptUserMessages?: number;
  durationMs?: number;
}

export interface SessionMessageSink {
  recordMessage(turnId: string, source: MessageSource, message: Message): Promise<void>;
  recordMessages(
    turnId: string,
    entries: readonly { source: MessageSource; message: Message }[],
  ): Promise<void>;
  /** Mid-loop auto-compaction records itself here; manual `/compress` goes through the shell. */
  recordCompaction(record: SessionCompactionRecord): Promise<void>;
}
