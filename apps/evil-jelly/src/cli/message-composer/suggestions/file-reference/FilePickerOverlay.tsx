/**
 * File-picker overlay for the @-trigger in MessageComposer.
 * Displays fuzzy-matched file and directory paths; Enter attaches the highlighted path
 * (single-select: one @ inserts one path, like Claude Code / Codex).
 */

import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import type { FuzzyPathRefMatch } from "../../../../domains/workspace/read/FuzzySearchService";
import { fuzzySearchPathRefsWithContext } from "../../../../domains/workspace/read/FuzzySearchService";
import type { ComposerPickerKeySink } from "../ComposerPicker";
import { ComposerPicker } from "../ComposerPicker";

const DEFAULT_MAX_VISIBLE_ROWS = 10;
const DEBOUNCE_MS = 150;

interface FilePickerOverlayProps {
  /** The query string after @ (e.g. for "@src/tool" the query is "src/tool"). */
  query: string;
  /** Called when the user picks the highlighted path. */
  onSelect: (path: string) => void;
  /** Called when the user completes a file or directory without attaching it yet. */
  onComplete: (path: string, directory: boolean) => void;
  /** Called when the user cancels (Esc). */
  onCancel: () => void;
  /** Maximum result rows to render without moving the prompt too far up. */
  maxVisibleRows?: number;
  /** Slot to publish the picker's key handler into (shared-stdin hosts). */
  keySink?: ComposerPickerKeySink;
}

export function FilePickerOverlay({
  query,
  onSelect,
  onComplete,
  onCancel,
  maxVisibleRows = DEFAULT_MAX_VISIBLE_ROWS,
  keySink,
}: FilePickerOverlayProps) {
  const [matches, setMatches] = useState<FuzzyPathRefMatch[]>([]);
  const [ignoredScope, setIgnoredScope] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeqRef = useRef(0);
  const needsRefreshRef = useRef(true);

  // Debounced fuzzy search
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    if (!query.trim()) {
      requestSeqRef.current += 1;
      setMatches([]);
      setIgnoredScope(null);
      return;
    }
    const requestSeq = ++requestSeqRef.current;
    debounceRef.current = setTimeout(async () => {
      const cachePolicy = needsRefreshRef.current ? "refresh" : "reuse";
      needsRefreshRef.current = false;
      try {
        const result = await fuzzySearchPathRefsWithContext(query, ".", 20, { cachePolicy });
        if (requestSeq !== requestSeqRef.current) {
          return;
        }
        setMatches(result.matches);
        setIgnoredScope(result.ignoredScope ?? null);
      } catch {
        if (cachePolicy === "refresh") {
          needsRefreshRef.current = true;
        }
        if (requestSeq !== requestSeqRef.current) {
          return;
        }
        setMatches([]);
        setIgnoredScope(null);
      }
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [query]);

  const canBrowse = matches.some((match) => match.kind === "directory");
  const showFooter = ignoredScope !== null || canBrowse;

  return (
    <Box flexDirection="column">
      <ComposerPicker
        items={matches}
        getKey={(match) => `${match.kind}:${match.path}`}
        onSelect={(match) => onSelect(match.path)}
        onComplete={(match) => onComplete(match.path, match.kind === "directory")}
        onBrowse={(match) => onComplete(match.path, true)}
        canBrowse={(match) => match.kind === "directory"}
        onCancel={onCancel}
        keySink={keySink}
        empty={<Text dimColor>No matching paths (ignored paths need an exact directory)</Text>}
        visibleRows={Math.max(1, maxVisibleRows - (showFooter ? 1 : 0))}
        renderItem={(match, { selected }) => (
          <Text color={selected ? "cyan" : undefined}>
            {selected ? "▸ " : "  "}
            {match.path}
            {match.kind === "directory" ? "/" : ""}
            {match.ignored ? <Text dimColor> (ignored)</Text> : null}
          </Text>
        )}
      />
      {showFooter ? (
        <Text dimColor>
          {`${ignoredScope ? `ignored scope: ${ignoredScope}/ · ` : ""}Tab complete · → browse · Enter attach`}
        </Text>
      ) : null}
    </Box>
  );
}
