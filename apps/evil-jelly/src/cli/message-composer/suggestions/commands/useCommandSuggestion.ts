import { useCallback, useEffect, useState } from "react";
import { extractSlashQuery, filterSlashCommands, type SlashCommand } from "./slashCommands";

export interface CommandSuggestion {
  matches: SlashCommand[];
  open: boolean;
  select: (name: string) => void;
  dismiss: () => void;
}

export function useCommandSuggestion({
  text,
  cursor,
  isMultiline,
  onSelect,
}: {
  text: string;
  cursor: number;
  isMultiline: boolean;
  onSelect: (name: string) => void;
}): CommandSuggestion {
  const [query, setQuery] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const nextQuery = isMultiline ? null : extractSlashQuery(text, cursor);
    if (nextQuery === null) {
      setDismissed(false);
      setQuery(null);
      return;
    }
    setQuery(dismissed ? null : nextQuery);
  }, [text, cursor, isMultiline, dismissed]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    setQuery(null);
  }, []);
  const select = useCallback(
    (name: string) => {
      setDismissed(false);
      setQuery(null);
      onSelect(name);
    },
    [onSelect],
  );
  const matches = query === null ? [] : filterSlashCommands(query);

  return { matches, open: matches.length > 0, select, dismiss };
}
