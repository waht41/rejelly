/**
 * Session interaction mode (shift+tab cycles it). Mode governs the ambiguous (confirm) shell tier
 * and fs writes; read-only commands auto-run and irreversible shell commands are confirmed in
 * every mode (see shellCommandPolicy). The host reads the current mode via an injected getMode at
 * confirm time.
 *
 *  - "normal": read-only runs; fs writes, ambiguous and irreversible commands are confirmed.
 *              Safe default.
 *  - "auto":   read-only runs; fs writes (create/edit/delete) auto-accept, and the ambiguous
 *              shell middle can be auto-approved by the model's own safety declaration in the
 *              command tool; irreversible shell commands are still confirmed.
 */

import { create } from "zustand";

export type AgentMode = "normal" | "auto";

/** Cycle order for shift+tab. */
export const MODE_ORDER: readonly AgentMode[] = ["normal", "auto"];

export const MODE_META: Record<AgentMode, { label: string; color: string; hint: string }> = {
  normal: { label: "normal", color: "gray", hint: "read-only runs · rest asks" },
  auto: {
    label: "auto-run",
    color: "greenBright",
    hint: "read-only runs · writes auto · ambiguous judged",
  },
};

interface ModeState {
  mode: AgentMode;
  setMode: (mode: AgentMode) => void;
  /** Advance to the next mode and return it. */
  cycleMode: () => AgentMode;
}

export const useModeStore = create<ModeState>((set, get) => ({
  mode: "normal",
  setMode: (mode) => set({ mode }),
  cycleMode: () => {
    const index = MODE_ORDER.indexOf(get().mode);
    const next = MODE_ORDER[(index + 1) % MODE_ORDER.length] ?? "normal";
    set({ mode: next });
    return next;
  },
}));

/**
 * Apply a `/mode` slash command — the terminal-independent way to switch modes (shift+tab depends
 * on the terminal emitting a back-tab sequence, which some Windows consoles do not). `/mode` cycles;
 * `/mode auto` and `/mode normal` set explicitly. Returns the new mode, or null if not a mode
 * command (so the caller can fall through to sending the text normally).
 */
export function applyModeCommand(text: string): AgentMode | null {
  const trimmed = text.trim();
  if (trimmed !== "/mode" && !trimmed.startsWith("/mode ")) {
    return null;
  }
  const arg = trimmed.slice("/mode".length).trim().toLowerCase();
  const store = useModeStore.getState();
  if (arg === "auto" || arg === "normal") {
    store.setMode(arg);
    return arg;
  }
  return store.cycleMode();
}

/** Reset to the safe default for a fresh CLI session (singleton store). */
export function resetModeSession(): void {
  useModeStore.setState({ mode: "normal" });
}
