/**
 * Journal Recording and Replay
 *
 * Functions for recording call results and replaying from snapshot.
 */

import { isJSONSafe } from "../../utils/object";
import type { JournalEntry } from "../context/snapshot";
import type { AgentContext } from "../context/type";
import { logger } from "../shared/logger/instance";
import type { JournalPayload, JournalQueryPayload } from "./type";

/**
 * Record journal entry
 *
 * @param ctx - Current context
 * @param callId - Deterministic call ID
 * @param payload - Journal payload with type-specific data
 */
export function recordJournal(ctx: AgentContext, callId: string, payload: JournalPayload): void {
  if (!ctx.enableSnapshot) return;
  // 1. Safe compute Input Hash
  // If Input itself is non-serializable (e.g., callback passed to child Agent), hashValue might fail
  // So we need try-catch protection

  // 2. Check if Output is serializable
  let finalOutput = payload.output;
  let serializationError: string | null = null;

  if (!isJSONSafe(payload.output)) {
    // may happen when tool with wrong handler
    logger.warn(
      `Non-serializable output detected in ${payload.type} "${callId}". ` +
        `This step will NOT be cached in Snapshot.`,
    );
    // Tombstone strategy: clear output, mark error
    finalOutput = undefined;
    serializationError = "Non-serializable output";
  }

  // 3. Build Entry
  const entry: JournalEntry = {
    output: finalOutput,
    contentHash: payload.contentHash,
    ...(serializationError ? { error: serializationError } : {}),
  };

  // 4. Write to Journal
  // Agent uses callId as key, prompt and tool use contentHash as key
  const journalKey = payload.type;
  if (payload.type === "prompt" || payload.type === "tool") {
    // Use contentHash as key for prompt and tool
    if (!payload.contentHash) {
      logger.warn(
        `Missing contentHash for ${payload.type} "${callId}". ` +
          `This entry will NOT be cached in Snapshot.`,
      );
      return;
    }
    ctx.draft.journal[journalKey][payload.contentHash] = entry;
  } else {
    throw new Error(`recordJournal Error: Unsupported journal payload: ${payload}`);
  }
}

/**
 * Get journal entry for replay
 *
 * @param ctx - Current context
 * @param callId - Deterministic call ID
 * @param payload - Journal query payload with type-specific validation data
 * @returns Journal entry if found and input matches, null otherwise
 */
export function getJournalEntry(
  ctx: AgentContext,
  callId: string,
  payload: JournalQueryPayload,
): JournalEntry | null {
  // Check if snapshot exists
  if (!ctx.snapshot) {
    return null;
  }

  // Get entry from snapshot's journal
  // Agent uses callId as key, prompt and tool use contentHash as key
  const journalKey = payload.type;
  let entry: JournalEntry | undefined;

  if (payload.type === "prompt" || payload.type === "tool") {
    // Use contentHash as key for prompt and tool
    if (!payload.contentHash) {
      return null;
    }
    entry = ctx.snapshot.journal[journalKey]?.[payload.contentHash];
  } else {
    throw new Error(`getJournalEntry Error: Unsupported journal payload: ${payload}`);
  }

  if (!entry) {
    return null;
  }

  // Check for serialization error (tombstone check)
  if (entry.error) {
    logger.warn(
      `[Rejelly] Skipping cache for ${payload.type} (callId: ${callId}) due to serialization error in snapshot.`,
    );
    return null;
  }

  return entry;
}
