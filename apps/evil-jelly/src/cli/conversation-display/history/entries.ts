import type { DiffBlockDetail, SessionBanner, ToolBlock, Turn } from "./model";
import type { HistorySequence } from "./sequence";

export function userTurn(sequence: HistorySequence, content: string): Turn {
  return { id: sequence.nextTurnId("user"), type: "user", content };
}

export function assistantStreamTurn(
  sequence: HistorySequence,
  content: string,
  final?: boolean,
): Turn {
  return {
    id: sequence.nextTurnId("assistant_stream"),
    type: "assistant_stream",
    content,
    ...(final === undefined ? {} : { final }),
  };
}

export function assistantCompletionTurns(
  sequence: HistorySequence,
  input: {
    content: string;
    visualRemainder: string;
    shouldHideFinal: boolean;
    durationMs: number | null;
  },
): Turn[] {
  const turns: Turn[] = [];
  if (input.shouldHideFinal && input.visualRemainder.length > 0) {
    turns.push(assistantStreamTurn(sequence, input.visualRemainder, true));
  }
  turns.push({
    id: sequence.nextTurnId("assistant"),
    type: "assistant",
    content: input.content,
    hidden: input.shouldHideFinal,
  });
  if (input.durationMs !== null) {
    turns.push(systemTurn(sequence, `Worked for ${formatTurnDuration(input.durationMs)}`, true));
  }
  return turns;
}

export function toolRoundTurn(sequence: HistorySequence, calls: number): Turn {
  return { id: sequence.nextTurnId("tool_round"), type: "tool_round", calls };
}

export function toolTurn(sequence: HistorySequence, block: ToolBlock, ordinal: number): Turn {
  return {
    id: sequence.nextTurnId("tool"),
    type: "tool",
    content: block.summary,
    tool: { ...block, ordinal: block.ordinal ?? ordinal },
  };
}

export function diffTurn(sequence: HistorySequence, diff: DiffBlockDetail): Turn {
  return { id: sequence.nextTurnId("diff"), type: "diff", diff };
}

export function bannerTurn(sequence: HistorySequence, banner: SessionBanner): Turn {
  return { id: sequence.nextTurnId("banner"), type: "banner", banner };
}

export function systemTurn(sequence: HistorySequence, content: string, oneLine?: boolean): Turn {
  return {
    id: sequence.nextTurnId("system"),
    type: "system",
    content,
    ...(oneLine === undefined ? {} : { oneLine }),
  };
}

/** `12345ms` → `12.3s`, `92345ms` → `1m 32s`. */
function formatTurnDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}
