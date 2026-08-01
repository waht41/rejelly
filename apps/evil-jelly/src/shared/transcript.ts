/**
 * Host-facing transcript view model: the shape a host renders as scrollback.
 *
 * This is a display projection, not a storage record — the session service produces it
 * (`services/session/sessionHistoryProjection`), the CLI store and host bindings consume it.
 * It lives here so neither side has to reach across the other's layer to name it.
 */

import type { UserInputAttachmentDisplay } from "./attachments/messageContent";
import type { SessionBlobMetadata, SessionBlobRef } from "./blobs/sessionBlobStore";

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
