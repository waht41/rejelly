/**
 * Host-facing transcript view model: the shape a host renders as scrollback.
 *
 * This is a display projection, not a storage record — the session service produces it
 * (`domains/session/projection/sessionHistoryProjection`), the CLI store and host bindings consume it.
 * It lives here so neither side has to reach across the other's layer to name it.
 */

import type { UserInputAttachmentDisplay } from "../model/prompt/frozenUserInput";
import type { ToolApprovalAnnotation, ToolObservationDetail } from "../tool-observation/model";
import type { SessionBlobMetadata, SessionBlobRef } from "./blobContract";

export const RESUME_VISIBLE_TURNS = 10;

export type TranscriptTurnStatus = "running" | "completed" | "interrupted" | "error" | "unknown";

/** Presentation-only turn updates; never part of the model context or storage schema. */
export interface TranscriptTurnUpdate {
  turnId: string;
  status: TranscriptTurnStatus;
  /** Remove a fresh input cancelled before any committed assistant/tool progress. */
  withdrawn?: true;
  /** Committed assistant/tool progress (or a steer) makes the fresh input non-withdrawable. */
  hasProgress?: true;
  prompt?: string;
  promptSummary?: string;
  answer?: string;
}

export interface TranscriptImage {
  blobRef: SessionBlobRef;
  detail?: "auto" | "low" | "high";
  metadata: SessionBlobMetadata;
}

export type TranscriptItem =
  | {
      id: string;
      type: "user" | "assistant";
      turnId: string;
      seq: number;
      content: string;
      inputKind?: "initial" | "steer";
      /** Compact authored input; paste bodies are represented by labels, not expanded. */
      promptSummary?: string;
      /** Reconstructed lifecycle on initial user items; absent for legacy history. */
      turnStatus?: TranscriptTurnStatus;
      /** Assistant text accompanying tool calls is commentary, not a final answer. */
      hasToolCalls?: true;
      attachments?: UserInputAttachmentDisplay[];
      images?: TranscriptImage[];
    }
  /**
   * Heads the tool items one assistant message issued together, so a resumed transcript groups
   * them the way the live view does. Derived from `tool_calls.length`, never stored: the batch
   * is already recorded as that array, and only batches of two or more get an item.
   */
  | {
      id: string;
      type: "tool_round";
      turnId: string;
      seq: number;
      calls: number;
    }
  | {
      id: string;
      type: "tool";
      turnId: string;
      seq: number;
      toolCallId: string;
      toolName: string;
      arguments?: string;
      summary?: string;
      detail?: ToolObservationDetail;
      approval?: ToolApprovalAnnotation;
      result?: string;
      resultImages?: TranscriptImage[];
      ok: boolean;
    }
  | {
      id: string;
      type: "system";
      turnId?: string;
      seq: number;
      kind: "compaction" | "interrupted" | "error";
      content: string;
    };

/** Return the suffix belonging to the newest initial user turns without discarding its tools. */
export function tailTranscriptByInitialTurns(
  items: readonly TranscriptItem[],
  tailTurns: number,
): TranscriptItem[] {
  if (!Number.isInteger(tailTurns) || tailTurns < 0) {
    throw new Error("tailTurns must be a non-negative integer");
  }
  if (tailTurns === 0) return [];

  const starts = items
    .map((item, index) => ({ item, index }))
    .filter(
      ({ item }) =>
        item.type === "user" && (item.inputKind === "initial" || item.turnId.startsWith("legacy:")),
    );
  return starts.length > tailTurns ? items.slice(starts.at(-tailTurns)!.index) : [...items];
}
