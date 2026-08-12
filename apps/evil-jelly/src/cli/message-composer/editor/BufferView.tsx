import type { DOMElement } from "ink";
import { Box, Text } from "ink";
import type { RefObject } from "react";
import type { ProjectedTokenSpan } from "./document/promptDocument";
import { projectedDisplayRuns } from "./document/promptDocument";
import type { WrappedRow } from "./softWrap";

interface BufferViewProps {
  /** Ref for the stable label+text row measured by usePromptLayout. */
  rowRef: RefObject<DOMElement | null>;
  label: string;
  rows: WrappedRow[];
  tokenSpans: readonly ProjectedTokenSpan[];
  placeholder: string;
  empty: boolean;
}

/** Paints the exact physical rows used for caret placement and keyboard navigation. */
export function BufferView({
  rowRef,
  label,
  rows,
  tokenSpans,
  placeholder,
  empty,
}: BufferViewProps) {
  return (
    <Box ref={rowRef} flexDirection="row">
      <Text bold>{label || "❯"} </Text>
      <Box flexDirection="column">
        {empty ? (
          <Text>
            <Text dimColor>{placeholder}</Text>
          </Text>
        ) : (
          // Rows are already wrapped to fit, so Ink must not wrap them again.
          // Drop trailing blanks so a width-filling row cannot overflow and
          // create a second physical row unknown to the caret model.
          rows.map((row, rowIndex) => {
            const rendered = row.text.trimEnd();
            const runs = projectedDisplayRuns(rendered, row.start, tokenSpans);
            return (
              <Text key={rowIndex}>
                {runs.length > 0
                  ? runs.map((run, runIndex) =>
                      run.token ? (
                        <Text key={runIndex} color="magenta" bold>
                          {run.text}
                        </Text>
                      ) : (
                        run.text
                      ),
                    )
                  : " "}
              </Text>
            );
          })
        )}
      </Box>
    </Box>
  );
}
