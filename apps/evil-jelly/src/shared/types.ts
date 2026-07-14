/**
 * Host protocol: bindings between the terminal/UI and the agent loop (Electron, tests, etc.).
 */

import type { AgentMode, LineInputValue, ToolConfirmationHandler } from "./AgentShared";

/** One row in a host-driven action menu (hotkey + arbitrary domain `value`). */
export type HostChoiceOption = { key: string; label: string; value: string };

/**
 * Optional transient pane while `requestChoice` is open (mirrors CLI `TransientView` shape).
 */
export type HostChoiceView =
  | { type: "none" }
  | { type: "diff"; text: string; caption?: string; captionTitle?: string }
  | { type: "markdown"; text: string };

export type PrintOutKind = "assistant" | "tool-progress";

export type ToolTranscriptDetail = {
  type: "diff";
  text: string;
  caption?: string;
  captionTitle?: string;
};

export interface EvilJellyHostBindings {
  /** One line of user input per call; host may prefix with a prompt inside getInput. */
  getInput: () => Promise<LineInputValue>;
  /**
   * Stream user-visible text for the **current turn** into the transient surface (tool logs, streaming LLM).
   * Finalized lines use {@link logUserMessage} / {@link logAssistantMessage} / {@link logSystemEvent}, not accumulation here as history.
   */
  printOut: (message: string, options?: { kind?: PrintOutKind }) => void;
  /** Append the current user line to host history (call as soon as input is known, before model work). */
  logUserMessage: (message: string) => void;
  /** Append the assistant’s final reply for this turn and reset the transient stream. */
  logAssistantMessage: (message: string) => void;
  /** Append a system line (startup, goodbye, fatal error) and reset the transient stream. */
  logSystemEvent: (message: string) => void;
  /** Clear host-visible conversation history when the host supports it. */
  clearHistory?: () => void;
  /**
   * Wipe the terminal screen and scrollback and repaint from a clean slate. Paired with
   * {@link clearHistory} for `/clear` so the committed backlog also disappears visually.
   */
  clearScreen?: () => void;
  /**
   * Show the session banner (model, workspace directory) at the top of a fresh view.
   * Shown at startup and again after `/clear` repaints from a clean slate.
   */
  showSessionBanner?: () => void; // todo some trivial
  /** Host status line (e.g. “Waiting for input”, “Ready”) without adding history. */
  onStatusUpdate?: (status: string) => void;
  /** Commit a finished tool call as a collapsed, persistent block (survives turn end). */
  logToolBlock: (block: {
    toolName: string;
    summary: string;
    args?: string;
    detail?: ToolTranscriptDetail;
    preview: string;
    fullResult: string;
    ok: boolean;
  }) => void;
  /**
   * Approve disk writes from edit_file / create_file after reviewing the unified diff.
   * Host maps `supportedActions` on the confirmation request to UI (e.g. Ink hotkeys, native dialog).
   */
  confirmTool: ToolConfirmationHandler;
  /** Current host interaction mode. Defaults to "normal" when omitted. */
  getAgentMode?: () => AgentMode;
  /**
   * Suspend and ask the user to pick one option (strategy dispatch, not patch review).
   * Returns the chosen option’s `value`.
   */
  requestChoice: (
    message: string,
    options: HostChoiceOption[],
    view?: HostChoiceView,
  ) => Promise<string>;
}
