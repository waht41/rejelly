import { useCallback, useRef } from "react";
import type { PastePromptToken } from "../../../../shared/model/prompt/promptDocument";
import { promptTokens } from "../../../../shared/model/prompt/promptDocument";
import type { TextBuffer } from "../document/textBuffer";
import { coalescePaste, PASTE_COALESCE_MS, type PasteRun } from "./collapsedPaste";

const PASTE_CHUNK_MERGE_MS = 120;

interface PendingPasteChunk {
  token: PastePromptToken;
  updatedAt: number;
}

export interface CollapsedPaste {
  handlePaste: (text: string) => boolean;
  reset: () => void;
  hasCollapsedPaste: boolean;
}

function pasteSpanBeforeCursor(buffer: TextBuffer) {
  return buffer.tokenSpans.find(
    (span) => span.logicalEnd === buffer.logicalCursor && span.token.kind === "paste",
  );
}

export function useCollapsedPaste(buffer: TextBuffer): CollapsedPaste {
  const pendingPasteChunkRef = useRef<PendingPasteChunk | null>(null);
  const pasteRunRef = useRef<PasteRun | null>(null);

  const reset = useCallback(() => {
    pendingPasteChunkRef.current = null;
    pasteRunRef.current = null;
  }, []);

  const handlePaste = useCallback(
    (text: string): boolean => {
      const span = pasteSpanBeforeCursor(buffer);
      const pending = pendingPasteChunkRef.current;
      const now = Date.now();
      if (span?.token.kind === "paste") {
        if (pending?.token === span.token && now - pending.updatedAt <= PASTE_CHUNK_MERGE_MS) {
          const token: PastePromptToken = {
            type: "token",
            kind: "paste",
            text: span.token.text + text,
          };
          buffer.replaceDisplayRange(span.start, span.end, [token]);
          pendingPasteChunkRef.current = { token, updatedAt: now };
          pasteRunRef.current = null;
          return true;
        }
        if (span.token.text === text) {
          buffer.replaceDisplayRange(span.start, span.end, [{ type: "text", text }]);
          pendingPasteChunkRef.current = null;
          pasteRunRef.current = null;
          return true;
        }
      }

      const { run, collapse } = coalescePaste(pasteRunRef.current, text, now, PASTE_COALESCE_MS);
      buffer.insert(text);
      if (!collapse) {
        pasteRunRef.current = run;
        return true;
      }

      const token: PastePromptToken = { type: "token", kind: "paste", text: run.text };
      buffer.replaceTextBeforeCursor(run.text, [token]);
      pendingPasteChunkRef.current = { token, updatedAt: now };
      pasteRunRef.current = null;
      return true;
    },
    [buffer],
  );

  return {
    handlePaste,
    reset,
    hasCollapsedPaste: promptTokens(buffer.document, "paste").length > 0,
  };
}
