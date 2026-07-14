/**
 * File-picker overlay for the @-trigger in SmartLinePrompt.
 * Displays fuzzy-matched file and directory paths; Enter attaches the highlighted path
 * (single-select: one @ inserts one path, like Claude Code / Codex).
 */

import { Text } from "ink";
import { useEffect, useRef, useState } from "react";
import type { FuzzyPathRefMatch } from "../../../services/fuzzy/FuzzySearchService";
import { fuzzySearchPathRefs } from "../../../services/fuzzy/FuzzySearchService";
import type { PickerKeySink } from "./ListPicker";
import { ListPicker } from "./ListPicker";

const DEFAULT_MAX_VISIBLE_ROWS = 10;
const DEBOUNCE_MS = 150;

interface FilePickerOverlayProps {
  /** The query string after @ (e.g. for "@src/tool" the query is "src/tool"). */
  query: string;
  /** Called when the user picks the highlighted path. */
  onSelect: (path: string) => void;
  /** Called when the user cancels (Esc). */
  onCancel: () => void;
  /** Maximum result rows to render without moving the prompt too far up. */
  maxVisibleRows?: number;
  /** Slot to publish the picker's key handler into (shared-stdin hosts). */
  keySink?: PickerKeySink;
}

export function FilePickerOverlay({
  query,
  onSelect,
  onCancel,
  maxVisibleRows = DEFAULT_MAX_VISIBLE_ROWS,
  keySink,
}: FilePickerOverlayProps) {
  const [matches, setMatches] = useState<FuzzyPathRefMatch[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeqRef = useRef(0);

  // Debounced fuzzy search
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    if (!query.trim()) {
      requestSeqRef.current += 1;
      setMatches([]);
      return;
    }
    const requestSeq = ++requestSeqRef.current;
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await fuzzySearchPathRefs(query, ".", 20);
        if (requestSeq !== requestSeqRef.current) {
          return;
        }
        setMatches(results);
      } catch {
        if (requestSeq !== requestSeqRef.current) {
          return;
        }
        setMatches([]);
      }
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [query]);

  return (
    <ListPicker
      items={matches}
      getId={(match) => match.path}
      onSelect={(match) => onSelect(match.path)}
      onCancel={onCancel}
      keySink={keySink}
      emptyText="No matching paths"
      maxVisibleRows={maxVisibleRows}
      renderItem={(match, { selected }) => (
        <Text color={selected ? "cyan" : undefined}>
          {selected ? "▸ " : "  "}
          {match.path}
          {match.kind === "directory" ? "/" : ""}
        </Text>
      )}
    />
  );
}
