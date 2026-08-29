/**
 * The write surface the agent loop needs from a durable session recorder.
 *
 * The concrete recorder (`domains/session/recorder/sessionRecorder`) implements this plus turn/segment
 * lifecycle, which only the shell drives. Callers below the shell — the policy layer, agent props —
 * depend on this narrow port instead, so they never reach into the session service.
 *
 * Each method resolves only after its complete batch has reached the file's durable boundary.
 * Callers must pass only immutable, completed messages.
 */

import type { Message } from "@rejelly/core";
import type { ToolObservationDetail } from "../tool-observation/model";
import type { NonUserMessageSource } from "./messageSource";

export interface SessionToolObservation {
  toolName: string;
  summary: string;
  args?: string;
  detail?: ToolObservationDetail;
  ok: boolean;
}

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
  recordMessage(turnId: string, source: NonUserMessageSource, message: Message): Promise<void>;
  recordMessages(
    turnId: string,
    entries: readonly { source: NonUserMessageSource; message: Message }[],
  ): Promise<void>;
  /** Durable presentation metadata keyed to the canonical model tool call. */
  recordToolObservation?(
    turnId: string,
    toolCallId: string,
    observation: SessionToolObservation,
  ): Promise<void>;
  /** Mid-loop auto-compaction records itself here; manual `/compress` goes through the shell. */
  recordCompaction(record: SessionCompactionRecord): Promise<void>;
}
