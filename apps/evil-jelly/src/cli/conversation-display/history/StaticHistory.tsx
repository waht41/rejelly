import { Box, Static } from "ink";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { parseMarkdownBlocks } from "../../terminal-ui/rich-text/markdownParser";
import {
  needsSyntaxHighlighter,
  requestSyntaxHighlighter,
  subscribeSyntaxHighlighter,
  syntaxHighlighterSnapshot,
} from "../../terminal-ui/rich-text/syntaxHighlight";
import { HistoryItem } from "./HistoryItem";
import type { Turn } from "./model";

interface SyntaxHighlightRequest {
  language: string;
  lines: string[];
}

function turnSyntaxHighlightRequest(turn: Turn): SyntaxHighlightRequest | undefined {
  if (
    (turn.type !== "assistant" && turn.type !== "assistant_stream") ||
    (turn.type === "assistant" && turn.hidden) ||
    (!turn.content.includes("```") && !turn.content.includes("~~~"))
  ) {
    return undefined;
  }

  for (const block of parseMarkdownBlocks(turn.content)) {
    if (block.type === "code" && needsSyntaxHighlighter(block.lines, block.language)) {
      return { language: block.language!, lines: block.lines };
    }
  }
  return undefined;
}

/**
 * Commits immutable history to Ink's scrollback only after optional syntax
 * highlighting has settled. Once a `<Static>` item is flushed it cannot be
 * revised, so the pending suffix temporarily remains in the live region.
 */
export function StaticHistory({
  turns,
  columns,
  hideTransient,
}: {
  turns: Turn[];
  columns: number;
  hideTransient: boolean;
}) {
  const syntaxHighlighterState = useSyncExternalStore(
    subscribeSyntaxHighlighter,
    syntaxHighlighterSnapshot,
    syntaxHighlighterSnapshot,
  );
  const pendingSyntax = useMemo(() => {
    if (syntaxHighlighterState === "ready" || syntaxHighlighterState === "unavailable") {
      return undefined;
    }
    for (let index = 0; index < turns.length; index++) {
      const request = turnSyntaxHighlightRequest(turns[index]!);
      if (request) return { index, request };
    }
    return undefined;
  }, [turns, syntaxHighlighterState]);
  const readyTurns = pendingSyntax ? turns.slice(0, pendingSyntax.index) : turns;
  const deferredTurns = pendingSyntax ? turns.slice(pendingSyntax.index) : [];

  useEffect(() => {
    if (pendingSyntax) {
      requestSyntaxHighlighter(pendingSyntax.request.lines, pendingSyntax.request.language);
    }
  }, [pendingSyntax]);

  return (
    <>
      <Static items={readyTurns}>
        {(turn) => <HistoryItem key={turn.id} turn={turn} columns={columns} />}
      </Static>
      {!hideTransient && deferredTurns.length > 0 ? (
        <Box flexDirection="column">
          {deferredTurns.map((turn) => (
            <HistoryItem key={turn.id} turn={turn} columns={columns} />
          ))}
        </Box>
      ) : null}
    </>
  );
}
