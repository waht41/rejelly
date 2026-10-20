import type { TranscriptItem, TranscriptTurnStatus } from "../../../shared/session/transcript";

export interface AnswerTranscriptEntry {
  id: string;
  prompt: string;
  promptSummary?: string;
  answer: string;
  status: TranscriptTurnStatus;
}

/** Keep real turn identities before the scrollback projection discards them. */
export function buildAnswerTranscript(items: readonly TranscriptItem[]): AnswerTranscriptEntry[] {
  const entries = new Map<string, AnswerTranscriptEntry>();
  const lifecycleKnown = new Set<string>();
  for (const item of items) {
    if (item.type === "user" && item.inputKind !== "steer") {
      const existing = entries.get(item.turnId);
      if (item.turnStatus) lifecycleKnown.add(item.turnId);
      entries.set(item.turnId, {
        id: item.turnId,
        prompt: item.content,
        ...(item.promptSummary === undefined ? {} : { promptSummary: item.promptSummary }),
        answer: existing?.answer ?? "",
        status: item.turnStatus ?? existing?.status ?? "unknown",
      });
      continue;
    }
    if (!item.turnId) continue;
    const entry = entries.get(item.turnId);
    if (!entry) continue;
    if (item.type === "assistant") {
      // Never promote a tool preamble to a completed answer. Failed turns can still show
      // their last committed text, explicitly labelled as partial by the reader.
      entry.answer = item.hasToolCalls && entry.status === "completed" ? "" : item.content;
    } else if (
      item.type === "system" &&
      item.kind !== "compaction" &&
      !lifecycleKnown.has(item.turnId)
    ) {
      entry.status = item.kind;
    }
  }
  return [...entries.values()];
}

export function filterAnswerTranscript(
  entries: readonly AnswerTranscriptEntry[],
  query: string,
): AnswerTranscriptEntry[] {
  const needle = query.trim().toLowerCase();
  return [...entries]
    .reverse()
    .filter(
      (entry) => !needle || `${entry.prompt}\n${entry.answer}`.toLowerCase().includes(needle),
    );
}
