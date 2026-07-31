import type { Message } from "@rejelly/core";
import {
  getUserInputDisplay,
  type UserInputAttachmentDisplay,
} from "../../shared/attachments/messageContent";
import {
  isCompactionBridgeMessage,
  unwrapPriorUserMessageText,
} from "../../shared/lib/compactionMessages";
import {
  SESSION_BLOB_SCHEME,
  type SessionBlobMetadata,
  type SessionBlobRef,
  sessionBlobRefSchema,
} from "./sessionBlobStore";
import type { SessionBudgetData } from "./sessionEvents";
import type { PreparedSessionReplay } from "./sessionReplay";
import { messageContentToText } from "./sessionStore";
import { getStoredSessionRejellyMetadata, type StoredSessionMessage } from "./storedSessionMessage";

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

export interface BuildTranscriptOptions {
  tailTurns?: number;
  includeCompactionBoundaries?: boolean;
}

/**
 * Recovery is a projection, not a retry policy. Dangling calls receive synthetic unknown-outcome
 * results solely to keep provider message ordering valid; no tool is executed during resume.
 */
function closeDanglingToolCalls(messages: StoredSessionMessage[]): StoredSessionMessage[] {
  const output: StoredSessionMessage[] = [];
  const pending = new Map<string, number>();

  const appendUnknownOutcomes = () => {
    for (const [toolCallId, count] of pending) {
      for (let index = 0; index < count; index += 1) {
        output.push({
          role: "tool",
          tool_call_id: toolCallId,
          content: "[Tool execution outcome is unknown because the turn was interrupted]",
          extra: { rejelly: { kind: "session_recovery" } },
        });
      }
    }
    pending.clear();
  };

  for (const message of messages) {
    if (message.role !== "tool") {
      appendUnknownOutcomes();
    }
    output.push(message);
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) {
        pending.set(call.id, (pending.get(call.id) ?? 0) + 1);
      }
    } else if (message.role === "tool" && message.tool_call_id) {
      const count = pending.get(message.tool_call_id) ?? 0;
      if (count <= 1) {
        pending.delete(message.tool_call_id);
      } else {
        pending.set(message.tool_call_id, count - 1);
      }
    }
  }
  appendUnknownOutcomes();
  return output;
}

export function buildStoredActiveContext(replay: PreparedSessionReplay): StoredSessionMessage[] {
  // message_recorded grows the current model context, while context_compacted resets only this
  // projection. Transcript construction below continues reading the original message events.
  let messages: StoredSessionMessage[] = [];
  const openTurns = new Set<string>();
  let needsRecovery = false;

  for (const event of replay.events) {
    switch (event.type) {
      case "legacy_snapshot":
        messages = [...event.messages];
        break;
      case "message_recorded":
        messages.push(event.message);
        if (event.source.kind === "user_input" && event.source.inputKind === "initial") {
          openTurns.add(event.turnId);
        }
        break;
      case "context_compacted":
        messages = [...event.replacementHistory];
        break;
      case "turn_completed":
        openTurns.delete(event.turnId);
        if (event.status !== "completed") {
          needsRecovery = true;
        }
        break;
      default:
        break;
    }
  }

  return openTurns.size > 0 || needsRecovery ? closeDanglingToolCalls(messages) : messages;
}

function assistantDisplayText(text: string): string {
  try {
    const parsed = JSON.parse(text) as { reply?: unknown };
    if (parsed && typeof parsed.reply === "string") {
      return parsed.reply;
    }
  } catch {
    // Plain assistant text is already display-ready.
  }
  return text;
}

function userTranscriptText(message: Message, legacy: boolean): string {
  const display = getUserInputDisplay(message);
  if (display) {
    return display.text;
  }
  const text = messageContentToText(message.content);
  return legacy ? unwrapPriorUserMessageText(text) : text.trim();
}

function transcriptImages(message: Message): TranscriptImage[] | undefined {
  if (!Array.isArray(message.content)) {
    return undefined;
  }
  const metadata = getStoredSessionRejellyMetadata(message)?.imageBlobs ?? {};
  const images: TranscriptImage[] = [];
  for (const part of message.content) {
    if (part.type !== "image" || !part.image.url.startsWith(SESSION_BLOB_SCHEME)) {
      continue;
    }
    const blobRef = sessionBlobRefSchema.parse(part.image.url);
    const blob = metadata[blobRef];
    if (!blob) {
      throw new Error(`Missing metadata for transcript image ${part.image.url}`);
    }
    images.push({
      blobRef,
      ...(part.image.detail ? { detail: part.image.detail } : {}),
      metadata: blob,
    });
  }
  return images.length > 0 ? images : undefined;
}

function appendTranscriptMessage(
  items: TranscriptItem[],
  pendingTools: Map<string, Extract<TranscriptItem, { type: "tool" }>>,
  message: Message,
  identity: { seq: number; turnId: string; suffix: string; legacy: boolean },
  inputKind?: "initial" | "steer",
): void {
  if (isCompactionBridgeMessage(message)) {
    return;
  }
  if (message.role === "user") {
    const content = userTranscriptText(message, identity.legacy);
    if (content) {
      const display = getUserInputDisplay(message);
      const images = identity.legacy ? undefined : transcriptImages(message);
      items.push({
        id: `${identity.seq}:${identity.suffix}:user`,
        type: "user",
        turnId: identity.turnId,
        seq: identity.seq,
        content,
        ...(inputKind ? { inputKind } : {}),
        ...(display?.attachments.length ? { attachments: display.attachments } : {}),
        ...(images ? { images } : {}),
      });
    }
    return;
  }
  if (message.role === "assistant") {
    const text = messageContentToText(message.content).trim();
    if (text) {
      items.push({
        id: `${identity.seq}:${identity.suffix}:assistant`,
        type: "assistant",
        turnId: identity.turnId,
        seq: identity.seq,
        content: assistantDisplayText(text),
      });
    }
    for (const [index, call] of (message.tool_calls ?? []).entries()) {
      const item: Extract<TranscriptItem, { type: "tool" }> = {
        id: `${identity.seq}:${identity.suffix}:tool:${index}`,
        type: "tool",
        turnId: identity.turnId,
        seq: identity.seq,
        toolCallId: call.id,
        toolName: call.name,
        arguments: call.arguments,
        ok: false,
      };
      items.push(item);
      pendingTools.set(call.id, item);
    }
    return;
  }
  if (message.role === "tool") {
    const result = messageContentToText(message.content).trim();
    const resultImages = identity.legacy ? undefined : transcriptImages(message);
    const existing = message.tool_call_id ? pendingTools.get(message.tool_call_id) : undefined;
    if (existing) {
      existing.result = result;
      existing.resultImages = resultImages;
      existing.ok = !result.startsWith("[Tool execution outcome is unknown");
      pendingTools.delete(existing.toolCallId);
      return;
    }
    items.push({
      id: `${identity.seq}:${identity.suffix}:tool-result`,
      type: "tool",
      turnId: identity.turnId,
      seq: identity.seq,
      toolCallId: message.tool_call_id ?? `${identity.seq}:${identity.suffix}:unknown`,
      toolName: message.name ?? "tool",
      result,
      ...(resultImages ? { resultImages } : {}),
      ok: true,
    });
  }
}

function tailTranscript(items: TranscriptItem[], tailTurns: number | undefined): TranscriptItem[] {
  if (tailTurns === undefined) {
    return items;
  }
  if (!Number.isInteger(tailTurns) || tailTurns < 0) {
    throw new Error("tailTurns must be a non-negative integer");
  }
  if (tailTurns === 0) {
    return [];
  }
  // Steers belong to their existing turn. Only initial inputs (or the conservative V1 synthetic
  // boundaries) consume one slot in the terminal hydration limit.
  const starts = items
    .map((item, index) => ({ item, index }))
    .filter(
      ({ item }) =>
        item.type === "user" && (item.inputKind === "initial" || item.turnId.startsWith("legacy:")),
    );
  return starts.length > tailTurns ? items.slice(starts.at(-tailTurns)!.index) : items;
}

export function buildTranscript(
  replay: PreparedSessionReplay,
  options: BuildTranscriptOptions = {},
): TranscriptItem[] {
  // Tool calls and results are folded into one display item, but their source events remain
  // untouched. Compaction replacementHistory is deliberately ignored: it is model context, not
  // user-visible conversation history.
  const items: TranscriptItem[] = [];
  const pendingTools = new Map<string, Extract<TranscriptItem, { type: "tool" }>>();

  for (const event of replay.events) {
    if (event.type === "legacy_snapshot") {
      let legacyTurn = 0;
      event.messages.forEach((message, index) => {
        if (message.role === "user" && !isCompactionBridgeMessage(message)) {
          legacyTurn += 1;
        }
        appendTranscriptMessage(items, pendingTools, message, {
          seq: event.seq,
          turnId: `legacy:${event.seq}:${legacyTurn}`,
          suffix: `legacy:${index}`,
          legacy: true,
        });
      });
      continue;
    }
    if (event.type === "message_recorded") {
      if (event.source.kind === "agent_runtime" || event.source.kind === "recovery") {
        continue;
      }
      appendTranscriptMessage(
        items,
        pendingTools,
        event.message,
        { seq: event.seq, turnId: event.turnId, suffix: "event", legacy: false },
        event.source.kind === "user_input" ? event.source.inputKind : undefined,
      );
      continue;
    }
    if (event.type === "context_compacted" && options.includeCompactionBoundaries) {
      items.push({
        id: `${event.seq}:compaction`,
        type: "system",
        seq: event.seq,
        ...(event.activeTurnId ? { turnId: event.activeTurnId } : {}),
        kind: "compaction",
        content: `Context compacted (${event.trigger}).`,
      });
      continue;
    }
    if (event.type === "turn_completed" && event.status !== "completed") {
      for (const tool of pendingTools.values()) {
        if (tool.turnId === event.turnId && tool.result === undefined) {
          tool.result = "[Tool execution outcome is unknown]";
          tool.ok = false;
          pendingTools.delete(tool.toolCallId);
        }
      }
      items.push({
        id: `${event.seq}:${event.status}`,
        type: "system",
        turnId: event.turnId,
        seq: event.seq,
        kind: event.status,
        content:
          event.status === "interrupted"
            ? "Turn interrupted."
            : "Turn ended with an internal error.",
      });
    }
  }

  return tailTranscript(items, options.tailTurns);
}

/** Build the display projection for a V1 record without guessing durable turn/round boundaries. */
export function buildLegacyTranscript(
  messages: readonly Message[],
  options: Pick<BuildTranscriptOptions, "tailTurns"> = {},
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const pendingTools = new Map<string, Extract<TranscriptItem, { type: "tool" }>>();
  let legacyTurn = 0;
  messages.forEach((message, index) => {
    if (isCompactionBridgeMessage(message)) {
      items.push({
        id: `legacy:${index}:compaction`,
        type: "system",
        seq: index + 1,
        kind: "compaction",
        content: "Context was compacted in a previous run.",
      });
      return;
    }
    if (message.role === "user") {
      legacyTurn += 1;
    }
    appendTranscriptMessage(items, pendingTools, message, {
      seq: index + 1,
      turnId: `legacy:0:${legacyTurn}`,
      suffix: `legacy:${index}`,
      legacy: true,
    });
  });
  return tailTranscript(items, options.tailTurns);
}

export function buildLatestBudget(replay: PreparedSessionReplay): SessionBudgetData | undefined {
  let budget: SessionBudgetData | undefined;
  for (const event of replay.events) {
    if (event.type === "legacy_snapshot") {
      budget = event.legacyMeta.budget;
    } else if (event.type === "budget_updated") {
      budget = event.budget;
    } else if (event.type === "session_state" && event.budget !== undefined) {
      budget = event.budget;
    }
  }
  return budget;
}
