import type { TranscriptItem } from "../../../shared/session/transcript";
import type { Turn } from "./model";
import type { HistorySequence } from "./sequence";
import { formatUserInputDisplay } from "./userInputDisplay";

export function projectTranscriptItem(item: TranscriptItem, sequence: HistorySequence): Turn {
  switch (item.type) {
    case "user": {
      const attachments = item.attachments ?? [];
      return {
        id: `resume_${item.id}`,
        type: "user",
        content: formatUserInputDisplay({ text: item.content, attachments }),
        ...(item.inputKind !== "steer"
          ? { presentation: { summary: item.promptSummary ?? item.content, attachments } }
          : {}),
      };
    }
    case "assistant":
      return {
        id: `resume_${item.id}`,
        type: "assistant",
        content: item.content,
        hidden: false,
      };
    case "system":
      return { id: `resume_${item.id}`, type: "system", content: item.content };
    case "tool_round":
      return { id: `resume_${item.id}`, type: "tool_round", calls: item.calls };
    case "tool": {
      const compactArgs = item.arguments?.trim().replace(/\s+/g, " ");
      const suffix =
        compactArgs && compactArgs.length > 120 ? `${compactArgs.slice(0, 117)}...` : compactArgs;
      const summary =
        item.summary ?? `[Tools] ${item.toolName}${suffix ? ` ${suffix}` : ""} (resumed)`;
      const fullResult = item.result ?? "";
      return {
        id: `resume_${item.id}`,
        type: "tool",
        content: summary,
        tool: {
          toolName: item.toolName,
          summary,
          args: item.arguments,
          detail: item.detail,
          approval: item.approval,
          preview: fullResult.split("\n").slice(0, 6).join("\n").slice(0, 600),
          fullResult,
          ok: item.ok,
          ordinal: sequence.nextToolOrdinal(),
        },
      };
    }
  }
}

export function projectTranscriptHistory(
  items: readonly TranscriptItem[],
  sequence: HistorySequence,
): Turn[] {
  return items.map((item) => projectTranscriptItem(item, sequence));
}
