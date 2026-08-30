import type { TranscriptItem } from "../../../shared/session/transcript";
import type { Turn } from "./model";
import type { HistorySequence } from "./sequence";

export function projectTranscriptItem(item: TranscriptItem, sequence: HistorySequence): Turn {
  switch (item.type) {
    case "user": {
      const actions = item.attachments?.map(
        (attachment) => `  -> ${attachment.action} ${attachment.label}`,
      );
      return {
        id: `resume_${item.id}`,
        type: "user",
        content: actions?.length ? `${item.content}\n${actions.join("\n")}` : item.content,
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
