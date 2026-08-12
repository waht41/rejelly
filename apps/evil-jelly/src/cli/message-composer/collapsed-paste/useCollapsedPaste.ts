import { useCallback, useRef, useState } from "react";
import {
  coalescePaste,
  expandPastedTextTokens,
  PASTE_COALESCE_MS,
  type PasteRun,
  pastedTextToken,
  pastedTextTokenBefore,
} from "../../prompt-editor/lineText";
import type { TextBuffer } from "../../prompt-editor/textBuffer";

const PASTE_CHUNK_MERGE_MS = 120;

interface PastedText {
  id: number;
  text: string;
}

interface PendingPasteChunk {
  id: number;
  updatedAt: number;
}

export interface CollapsedPaste {
  /** Consume a sanitized text-input fragment, inserting or collapsing it as needed. */
  handlePaste: (text: string) => boolean;
  /** Replace every live collapsed-paste token with its original text. */
  expand: (text: string) => string;
  /** Forget all paste runs and token contents for a fresh draft. */
  reset: () => void;
  /** Whether the current buffer still contains at least one collapsed-paste token. */
  hasCollapsedPaste: boolean;
}

export function useCollapsedPaste(buffer: TextBuffer): CollapsedPaste {
  const [pastedTexts, setPastedTexts] = useState<PastedText[]>([]);
  const pastedTextsRef = useRef<PastedText[]>([]);
  const nextPasteIdRef = useRef(1);
  const pendingPasteChunkRef = useRef<PendingPasteChunk | null>(null);
  // A run of printable input arriving faster than a human types — a paste
  // fragmented into sub-threshold events. Each fragment is inserted immediately;
  // the run is replaced by a token only after it crosses the collapse threshold.
  const pasteRunRef = useRef<PasteRun | null>(null);

  const reset = useCallback(() => {
    setPastedTexts([]);
    pastedTextsRef.current = [];
    nextPasteIdRef.current = 1;
    pendingPasteChunkRef.current = null;
    pasteRunRef.current = null;
  }, []);

  const expand = useCallback(
    (text: string) => expandPastedTextTokens(text, pastedTextsRef.current),
    [],
  );

  const handlePaste = useCallback(
    (text: string): boolean => {
      const tokenBefore = pastedTextTokenBefore(buffer.text, buffer.cursor);
      if (tokenBefore) {
        const id = Number(tokenBefore.match(/#(\d+)/)?.[1]);
        const pasted = pastedTextsRef.current.find((entry) => entry.id === id);
        const pending = pendingPasteChunkRef.current;
        const now = Date.now();
        if (pasted && pending?.id === id && now - pending.updatedAt <= PASTE_CHUNK_MERGE_MS) {
          const mergedText = pasted.text + text;
          const nextToken = pastedTextToken(id, mergedText);
          pastedTextsRef.current = pastedTextsRef.current.map((entry) =>
            entry.id === id ? { ...entry, text: mergedText } : entry,
          );
          pendingPasteChunkRef.current = { id, updatedAt: now };
          pasteRunRef.current = null;
          setPastedTexts(pastedTextsRef.current);
          buffer.apply((state) => ({
            text:
              state.text.slice(0, state.cursor - tokenBefore.length) +
              nextToken +
              state.text.slice(state.cursor),
            cursor: state.cursor - tokenBefore.length + nextToken.length,
          }));
          return true;
        }
        if (pasted?.text === text) {
          buffer.apply((state) => ({
            text:
              state.text.slice(0, state.cursor - tokenBefore.length) +
              text +
              state.text.slice(state.cursor),
            cursor: state.cursor - tokenBefore.length + text.length,
          }));
          pendingPasteChunkRef.current = null;
          pasteRunRef.current = null;
          return true;
        }
      }

      const now = Date.now();
      const { run, collapse } = coalescePaste(pasteRunRef.current, text, now, PASTE_COALESCE_MS);
      buffer.insert(text);
      if (!collapse) {
        pasteRunRef.current = run;
        return true;
      }

      const accumulatedText = run.text;
      const id = nextPasteIdRef.current++;
      const token = pastedTextToken(id, accumulatedText);
      pastedTextsRef.current = [...pastedTextsRef.current, { id, text: accumulatedText }];
      pendingPasteChunkRef.current = { id, updatedAt: now };
      pasteRunRef.current = null;
      setPastedTexts(pastedTextsRef.current);
      // Retroactively swap the just-inserted run for its token. A functional
      // update composes with queued inserts from the same burst; bail if an edit
      // moved the caret away from the end of the accumulated run.
      buffer.apply((state) => {
        const start = state.cursor - accumulatedText.length;
        if (start < 0 || state.text.slice(start, state.cursor) !== accumulatedText) {
          return state;
        }
        return {
          text: state.text.slice(0, start) + token + state.text.slice(state.cursor),
          cursor: start + token.length,
        };
      });
      return true;
    },
    [buffer],
  );

  const hasCollapsedPaste = pastedTexts.some((entry) =>
    buffer.text.includes(pastedTextToken(entry.id, entry.text)),
  );

  return { handlePaste, expand, reset, hasCollapsedPaste };
}
