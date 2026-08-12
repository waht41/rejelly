import { useCallback, useEffect, useState } from "react";
import type { TextBuffer } from "../../editor/document/textBuffer";
import { extractAtQuery, refsMissingFromText, replaceAtToken } from "./atTrigger";

export interface FileReferenceSuggestion {
  query: string | null;
  open: boolean;
  select: (path: string) => void;
  dismiss: () => void;
}

export function useFileReferenceSuggestion({
  buffer,
  selectedFiles,
  setSelectedFiles,
}: {
  buffer: TextBuffer;
  selectedFiles: string[];
  setSelectedFiles: (paths: string[]) => void;
}): FileReferenceSuggestion {
  const [query, setQuery] = useState<string | null>(null);

  useEffect(() => {
    setQuery(extractAtQuery(buffer.text, buffer.cursor));
  }, [buffer.text, buffer.cursor]);

  const select = useCallback(
    (path: string) => {
      setSelectedFiles([...selectedFiles, path]);
      buffer.apply((state) => replaceAtToken(state, refsMissingFromText(state.text, [path])));
      setQuery(null);
    },
    [buffer.apply, selectedFiles, setSelectedFiles],
  );
  const dismiss = useCallback(() => {
    buffer.apply((state) => replaceAtToken(state, []));
    setQuery(null);
  }, [buffer.apply]);

  return { query, open: query !== null, select, dismiss };
}
