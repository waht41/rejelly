import { useCallback, useEffect, useState } from "react";
import type { TextBuffer } from "../../editor/document/textBuffer";
import { activeAtTrigger } from "./atTrigger";

export interface FileReferenceSuggestion {
  query: string | null;
  open: boolean;
  select: (path: string) => void;
  complete: (path: string, directory: boolean) => void;
  dismiss: () => void;
}

export function useFileReferenceSuggestion({
  buffer,
  attachFile,
}: {
  buffer: TextBuffer;
  attachFile: (path: string, start: number, end: number) => void;
}): FileReferenceSuggestion {
  const [query, setQuery] = useState<string | null>(null);
  const [dismissedTriggerStart, setDismissedTriggerStart] = useState<number | null>(null);

  useEffect(() => {
    const followsSemanticToken = buffer.tokenSpans.some(
      (span) => span.start < buffer.cursor && buffer.cursor <= span.end,
    );
    const trigger = followsSemanticToken ? null : activeAtTrigger(buffer.text, buffer.cursor);
    if (trigger === null) {
      setDismissedTriggerStart(null);
      setQuery(null);
      return;
    }
    setQuery(trigger.start === dismissedTriggerStart ? null : trigger.query);
  }, [buffer.text, buffer.cursor, buffer.tokenSpans, dismissedTriggerStart]);

  const select = useCallback(
    (path: string) => {
      const trigger = activeAtTrigger(buffer.text, buffer.cursor);
      if (!trigger) return;
      attachFile(path, trigger.start, trigger.end);
      setQuery(null);
    },
    [attachFile, buffer.cursor, buffer.text],
  );
  const complete = useCallback(
    (path: string, directory: boolean) => {
      const trigger = activeAtTrigger(buffer.text, buffer.cursor);
      if (!trigger) return;
      const normalizedPath = path.replace(/[\\/]+$/, "");
      const nextQuery = directory ? `${normalizedPath}/` : normalizedPath;
      buffer.replaceDisplayRange(trigger.start, trigger.end, [
        { type: "text", text: `@${nextQuery}` },
      ]);
      setQuery(nextQuery);
    },
    [buffer.cursor, buffer.replaceDisplayRange, buffer.text],
  );
  const dismiss = useCallback(() => {
    const trigger = activeAtTrigger(buffer.text, buffer.cursor);
    setDismissedTriggerStart(trigger?.start ?? null);
    setQuery(null);
  }, [buffer.cursor, buffer.text]);

  return { query, open: query !== null, select, complete, dismiss };
}
