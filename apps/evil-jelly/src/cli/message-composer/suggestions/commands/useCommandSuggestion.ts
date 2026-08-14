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

  useEffect(() => {
    setQuery(isMultiline ? null : extractSlashQuery(text, cursor));
  }, [text, cursor, isMultiline]);

  const dismiss = useCallback(() => setQuery(null), []);
  const select = useCallback(
    (name: string) => {
      setQuery(null);
      onSelect(name);
    },
    [onSelect],
  );
  const matches = query === null ? [] : filterSlashCommands(query);

  return { matches, open: matches.length > 0, select, dismiss };
}
