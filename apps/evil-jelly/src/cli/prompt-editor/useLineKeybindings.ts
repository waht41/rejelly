/**
 * Keyboard handling for the line prompt, split out of the component.
 *
 * Hybrid by design: the pure caret/delete motions (arrows, Home/End, the
 * readline Ctrl-a/e/u/w shortcuts) are homogeneous — each is just a key
 * predicate plus a buffer op with no dependency on prompt state — so they live
 * as a small table (MOTIONS) consulted by one loop. The context-sensitive keys
 * (submit, escape, backspace, tab, paste) carry guards that depend on external
 * state, so they stay as explicit imperative handlers; pressing them into the
 * table would just be code disguised as data. Order is significant and matches
 * the original source order (e.g. Shift+Tab must precede plain Tab).
 */

import { type Key, useInput } from "ink";
import { hasRuntimeTask } from "../../services/stop/runtimeControl";
import { normalizeNewlines } from "../../shared/lib/string";
import { useModeStore } from "../store/useModeStore";
import {
  imageTokenBefore,
  looksBinary,
  pastedTextTokenBefore,
  stripControlChars,
} from "./lineText";
import { cursorRowCol, type TextBuffer } from "./textBuffer";

// Tab inserts spaces up to the next multiple of this; see the key.tab handler.
const TAB_WIDTH = 2;

interface MotionBinding {
  when: (input: string, key: Key) => boolean;
  run: (buf: TextBuffer, key: Key) => void;
}

// Pure caret/delete motions: no prompt state, no branching action. Read top to
// bottom like a keymap; first match wins.
const MOTIONS: MotionBinding[] = [
  {
    when: (_i, k) => k.leftArrow,
    run: (b, k) => (k.ctrl || k.meta ? b.moveWordLeft() : b.moveLeft()),
  },
  {
    when: (_i, k) => k.rightArrow,
    run: (b, k) => (k.ctrl || k.meta ? b.moveWordRight() : b.moveRight()),
  },
  { when: (_i, k) => k.upArrow, run: (b) => b.moveUp() },
  { when: (_i, k) => k.downArrow, run: (b) => b.moveDown() },
  { when: (_i, k) => k.home, run: (b) => b.moveLineStart() },
  { when: (_i, k) => k.end, run: (b) => b.moveLineEnd() },
  { when: (i, k) => k.ctrl && (i === "a" || i === "A"), run: (b) => b.moveLineStart() },
  { when: (i, k) => k.ctrl && (i === "e" || i === "E"), run: (b) => b.moveLineEnd() },
  { when: (i, k) => k.ctrl && (i === "u" || i === "U"), run: (b) => b.deleteToLineStart() },
  { when: (i, k) => k.ctrl && (i === "w" || i === "W"), run: (b) => b.deleteWordLeft() },
];

export interface LineKeybindingDeps {
  buf: TextBuffer;
  /**
   * Slot holding the key handler of the currently open picker overlay (slash
   * palette / @-file picker), or null when none is open. The overlay gets first
   * claim on every key and returns true for the ones it consumed; the editor
   * handles the rest. Which keys it consumes is the overlay's own business —
   * don't enumerate them here.
   */
  overlayKeys?: { current: ((input: string, key: Key) => boolean) | null };
  isAgentRunning: boolean;
  selectedFiles: string[];
  selectedImages: string[];
  /** Send a bare control command to the host (used for `/stop`). */
  submitLine: (value: string) => void;
  removeSelectedFile: (path: string) => void;
  clearDraft: () => void;
  submit: () => void;
  attachClipboardImage: () => void;
  handleTextPaste?: (text: string) => boolean;
}

export function useLineKeybindings(deps: LineKeybindingDeps): void {
  const {
    buf,
    overlayKeys,
    isAgentRunning,
    selectedFiles,
    selectedImages,
    submitLine,
    removeSelectedFile,
    clearDraft,
    submit,
    attachClipboardImage,
    handleTextPaste,
  } = deps;

  useInput((input, key) => {
    // An open picker overlay claims its keys first (nav/commit/cancel, plus
    // whatever its config adds); the editor handles everything it declines.
    if (overlayKeys?.current?.(input, key)) {
      return;
    }
    if (key.escape && (isAgentRunning || hasRuntimeTask())) {
      submitLine("/stop");
      return;
    }
    if (key.escape) {
      if (buf.text.length > 0 || selectedFiles.length > 0 || selectedImages.length > 0) {
        clearDraft();
      }
      return;
    }

    // Shift+Tab cycles the session interaction mode (normal ⇄ auto). Must precede the plain-Tab
    // handler below, which inserts spaces.
    if (key.tab && key.shift) {
      useModeStore.getState().cycleMode();
      return;
    }

    if (key.meta && (input === "v" || input === "V")) {
      attachClipboardImage();
      return;
    }

    if (key.return) {
      // Newline: Alt/Shift+Enter (where the terminal sends them), or a trailing
      // backslash before the caret (works on every terminal). Otherwise submit.
      if (key.meta || key.shift) {
        buf.insert("\n");
        return;
      }
      if (buf.text.slice(0, buf.cursor).endsWith("\\")) {
        buf.apply((s) => {
          const head = s.text.slice(0, s.cursor).replace(/\\$/, "");
          return { text: `${head}\n${s.text.slice(s.cursor)}`, cursor: head.length + 1 };
        });
        return;
      }
      // Image tokens count as text, so trim() already covers an image-only line.
      if (buf.text.trim().length > 0 || selectedFiles.length > 0) {
        submit();
      }
      return;
    }

    // Pure caret/delete motions (table above); first match wins.
    for (const motion of MOTIONS) {
      if (motion.when(input, key)) {
        motion.run(buf, key);
        return;
      }
    }

    // Backspace / Delete: terminals conflate these onto the Backspace key, so
    // both erase the char before the caret (Ctrl/Alt erases the word).
    if (key.backspace || key.delete) {
      if (buf.text.length === 0 && selectedFiles.length > 0) {
        const last = selectedFiles[selectedFiles.length - 1];
        if (last) removeSelectedFile(last);
      } else if (key.ctrl || key.meta) {
        buf.deleteWordLeft();
      } else {
        // Delete whole inline placeholders in one stroke (like cc).
        const token =
          imageTokenBefore(buf.text, buf.cursor) ?? pastedTextTokenBefore(buf.text, buf.cursor);
        if (token) {
          buf.apply((s) => ({
            text: s.text.slice(0, s.cursor - token.length) + s.text.slice(s.cursor),
            cursor: s.cursor - token.length,
          }));
        } else {
          buf.backspace();
        }
      }
      return;
    }
    if (key.tab) {
      // Insert spaces, not a literal "\t": the render/caret pipeline assumes
      // 1 char == 1 terminal cell (cursorRowCol, renderLine's slice, and Ink's
      // width measurement all count chars), but terminals expand a tab to the
      // next tab stop (~8 cells). That mismatch shifts the caret and overflows
      // the bordered Box, wrapping the line and leaving a stray border. Pad to
      // the next tab stop so the buffer stays exactly as wide as it renders.
      const { col } = cursorRowCol(buf.text, buf.cursor);
      buf.insert(" ".repeat(TAB_WIDTH - (col % TAB_WIDTH)));
      return;
    }

    if (input.length > 0 && !key.ctrl && !key.meta) {
      const normalized = normalizeNewlines(input);
      // Pasting an image (Ctrl+V) dumps garbage bytes here rather than text.
      // Don't corrupt the buffer with it — pull the real image off the OS
      // clipboard and attach it as an [Image #N] placeholder instead.
      if (looksBinary(normalized)) {
        attachClipboardImage();
        return;
      }
      const sanitized = stripControlChars(normalized);
      if (handleTextPaste?.(sanitized)) {
        return;
      }
      buf.insert(sanitized);
    }
  });
}
