import { Box, Text, useInput, useWindowSize } from "ink";
import { useMemo, useState } from "react";
import { ListViewport } from "../../terminal-ui/picker/ListViewport";
import { moveListSelection } from "../../terminal-ui/picker/listNavigation";
import { answerAnchorRow, answerDisplayText, layoutAnswer, layoutPromptSummary } from "./layout";
import { filterAnswerTranscript } from "./projection";
import { useAnswerTranscriptStore } from "./viewStore";

export function AnswerTranscriptOverlay({
  copyText,
}: {
  copyText: (text: string) => Promise<void>;
}) {
  const { columns, rows } = useWindowSize();
  const state = useAnswerTranscriptStore();
  const [notice, setNotice] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchOrigin, setSearchOrigin] = useState("");
  const selected = state.entries.find((entry) => entry.id === state.selectedId);
  const selectedIndex = state.entries.findIndex((entry) => entry.id === state.selectedId);
  const filtered = useMemo(
    () => filterAnswerTranscript(state.entries, state.query),
    [state.entries, state.query],
  );
  const listIndex = Math.max(
    0,
    filtered.findIndex((entry) => entry.id === state.selectedId),
  );
  const question = state.detail === "question";
  const summary = selected?.promptSummary ?? selected?.prompt ?? "";
  const summaryLines = useMemo(() => layoutPromptSummary(summary, columns), [summary, columns]);
  const body = question
    ? selected?.prompt || "No original question text for this turn."
    : selected?.status === "running"
      ? "This turn is still running. Completed output will appear when it ends."
      : selected?.answer || "No committed answer text for this turn.";
  const lines = useMemo(() => layoutAnswer(body, columns), [body, columns]);
  const contextRows = state.mode === "list" || question ? 1 : summaryLines.length;
  const viewportRows = Math.max(1, rows - 3 - contextRows);
  const maxOffset = Math.max(0, lines.length - viewportRows);
  const offset = Math.min(
    answerAnchorRow(lines, question ? state.questionAnchor : state.anchor),
    maxOffset,
  );
  const pageStep = Math.max(1, Math.floor(viewportRows * 0.8));
  const moveTo = (next: number) => {
    const row = lines[Math.max(0, Math.min(next, maxOffset))];
    if (row) {
      const anchor = { line: row.line, offset: row.offset };
      if (question) state.setQuestionAnchor(anchor);
      else state.setAnchor(anchor);
    }
  };
  const select = (id: string) => {
    state.select(id);
    setNotice("");
  };

  useInput((input, key) => {
    if (key.ctrl && input === "t") {
      state.closeTranscript();
      return;
    }
    if (searching) {
      if (key.escape || key.return) {
        if (key.escape) state.setQuery(searchOrigin);
        setSearching(false);
      } else if (key.backspace || key.delete) {
        state.setQuery(Array.from(state.query).slice(0, -1).join(""));
      } else if (!key.ctrl && !key.meta && input) {
        state.setQuery(state.query + answerDisplayText(input).replace(/\n|\t/g, " "));
      }
      return;
    }
    if (key.escape) {
      state.closeTranscript();
      return;
    }
    if (input === "/") {
      setSearchOrigin(state.query);
      state.setMode("list");
      setSearching(true);
      return;
    }
    if (key.tab) {
      if (state.mode === "list") {
        if (filtered[listIndex]) select(filtered[listIndex]!.id);
        state.setDetail("answer");
      }
      state.setMode(state.mode === "detail" ? "list" : "detail");
      return;
    }
    if (state.mode === "list") {
      if (key.return && filtered[listIndex]) {
        select(filtered[listIndex]!.id);
        state.setDetail("answer");
        state.setMode("detail");
      } else if (
        key.upArrow ||
        key.downArrow ||
        key.pageUp ||
        key.pageDown ||
        key.home ||
        key.end
      ) {
        const command = key.home
          ? "home"
          : key.end
            ? "end"
            : key.pageUp
              ? "page-up"
              : key.pageDown
                ? "page-down"
                : key.upArrow
                  ? "up"
                  : "down";
        const index = moveListSelection({
          selectedIndex: listIndex,
          itemCount: filtered.length,
          command,
          pageStep,
        });
        if (filtered[index]) select(filtered[index]!.id);
      }
      return;
    }
    if (input === "p" && !key.ctrl && !key.meta) {
      state.setDetail(question ? "answer" : "question");
      setNotice("");
      return;
    }
    if (key.leftArrow || key.rightArrow) {
      const index = Math.max(
        0,
        Math.min(state.entries.length - 1, selectedIndex + (key.leftArrow ? -1 : 1)),
      );
      const entry = state.entries[index];
      if (entry && entry.id !== selected?.id) select(entry.id);
    } else if (key.upArrow || key.downArrow || key.pageUp || key.pageDown || key.home || key.end) {
      moveTo(
        key.home
          ? 0
          : key.end
            ? maxOffset
            : offset + (key.pageUp ? -pageStep : key.pageDown ? pageStep : key.upArrow ? -1 : 1),
      );
    } else if (
      input === "c" &&
      selected &&
      (question ? selected.prompt : selected.answer && selected.status !== "running")
    ) {
      setNotice("Copying…");
      void copyText(question ? selected.prompt : selected.answer).then(
        () => setNotice(`Copied complete ${question ? "question" : "answer"}.`),
        (error: unknown) =>
          setNotice(`Copy failed: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
  });

  const viewLabel = state.mode === "list" ? "Turns" : question ? "Question" : "Answer";
  const status =
    selected?.status === "completed"
      ? "Completed"
      : selected?.status === "unknown"
        ? "Legacy · status unknown"
        : selected?.status === "running"
          ? "Running"
          : `${selected?.status ?? "Empty"} · partial output`;
  return (
    <Box flexDirection="column" width={columns} height={rows} overflow="hidden">
      <Text wrap="truncate-end" bold color="cyan">
        {columns < 60
          ? `${selected?.status ?? "Empty"} · ${selectedIndex + 1}/${state.entries.length} · ${viewLabel}`
          : `Transcript · ${viewLabel} · Markdown source · ${
              selectedIndex >= 0
                ? `Turn ${selectedIndex + 1}/${state.entries.length} · ${status}`
                : "No turns"
            }`}
      </Text>
      <Box flexDirection="column" height={contextRows} overflow="hidden">
        {state.mode === "list" ? (
          <Text wrap="truncate-end" dimColor>
            {`Search: ${state.query}${searching ? "▌" : " · / edit search"}`}
          </Text>
        ) : question ? (
          <Text wrap="truncate-end" dimColor>
            You · original submitted input · p back to answer
          </Text>
        ) : (
          summaryLines.map((line, index) => (
            <Text key={index} wrap="truncate-end" dimColor>
              {line || " "}
            </Text>
          ))
        )}
      </Box>
      <Box flexDirection="column" height={viewportRows} overflow="hidden">
        {state.mode === "list" ? (
          <ListViewport
            items={filtered}
            selectedIndex={listIndex}
            visibleRows={viewportRows}
            getKey={(entry) => entry.id}
            empty={
              <Text dimColor>
                {state.entries.length ? "No matching turns." : "No answers in this session yet."}
              </Text>
            }
            renderItem={(entry, { selected: active }) => (
              <Text wrap="truncate-end" inverse={active} color={active ? "cyan" : undefined}>
                {entry.status} ·{" "}
                {answerDisplayText(entry.promptSummary ?? entry.prompt).replace(/\n/g, " ")}
              </Text>
            )}
          />
        ) : (
          lines.slice(offset, offset + viewportRows).map((row, index) => (
            <Text key={offset + index} wrap="truncate-end">
              {row.text || " "}
            </Text>
          ))
        )}
      </Box>
      <Text wrap="truncate-end" dimColor>
        {notice ||
          (state.mode === "detail"
            ? `Lines ${offset + 1}–${Math.min(lines.length, offset + viewportRows)}/${lines.length}`
            : `${filtered.length} matching turns`)}
        {state.entries.length > state.openedEntryCount ? " · New turns available" : ""}
      </Text>
      <Text wrap="truncate-end" dimColor>
        {searching
          ? "Type to search questions and answers · Enter done · Esc cancel search"
          : state.mode === "list"
            ? "↑↓ PgUp/PgDn select · Enter open · / search · Tab answer · Esc close"
            : `p ${question ? "answer" : "question"} · ←→ turn · ↑↓ PgUp/PgDn Home/End scroll · Tab turns · / search · c copy · Esc close`}
      </Text>
    </Box>
  );
}
