/**
 * Host protocol: bindings between the terminal/UI and the agent loop (Electron, tests, etc.).
 */

import type {
  AgentMode,
  LineInputValue,
  ToolConfirmationHandler,
  UserSkillListItem,
} from "./AgentShared";
import type { TranscriptItem } from "./session/transcript";
import type {
  ToolCallHandle,
  ToolObservationBlock,
  ToolObservationStart,
} from "./tool-observation/model";

/** One row in a host-driven action menu (hotkey + arbitrary domain `value`). */
export type HostChoiceOption = { key: string; label: string; value: string };

/**
 * Optional transient pane while `requestChoice` is open (mirrors CLI `TransientView` shape).
 */
export type HostChoiceView =
  | { type: "none" }
  | { type: "diff"; text: string; caption?: string; captionTitle?: string }
  | { type: "markdown"; text: string };

/**
 * What the runtime is doing right now.
 *
 * Deliberately separate from the free-text status detail ({@link EvilJellyHostBindings.onDetailUpdate}):
 * this enum answers "is the agent busy, and doing what" — which drives the status line's label,
 * its elapsed timer, and the idle/active decision — while the detail string is only ever rendered.
 * Folding both into one string is how `startsWith("Waiting for ")` ended up deciding whether the
 * agent was running.
 *
 * `connecting` is the phase worth watching: it spans `turn_start` until the model's first stream
 * event, so a wedged proxy or gateway shows up as a counter climbing with nothing else on screen.
 */
export type RuntimePhase =
  | "idle"
  | "connecting"
  | "thinking"
  | "streaming"
  | "compacting"
  | "tool"
  | "working"
  | "awaiting_user";

export interface EvilJellyHostBindings {
  /** One line of user input per call; host may prefix with a prompt inside getInput. */
  getInput: () => Promise<LineInputValue>;
  /** Replace the path-free Skill catalog exposed by the host's explicit-selection UI. */
  setAvailableSkills?: (skills: UserSkillListItem[]) => void;
  /**
   * Stream the assistant's text for the **current turn** into the transient surface.
   * Finalized lines use {@link logUserMessage} / {@link logAssistantMessage} / {@link logSystemEvent}, not accumulation here as history.
   *
   * This is the assistant's voice only. A tool's own output belongs to
   * {@link appendToolOutput} — routing it here makes it read as something the
   * model said, and commits it to scrollback in full.
   */
  printOut: (message: string) => void;
  /** Append the current user line to host history (call as soon as input is known, before model work). */
  logUserMessage: (message: string) => void;
  /** Append the assistant’s final reply for this turn and reset the transient stream. */
  logAssistantMessage: (message: string) => void;
  /** Append a system line (startup, goodbye, fatal error) and reset the transient stream. */
  logSystemEvent: (message: string) => void;
  /**
   * Atomically hydrate a bounded resume transcript before live turns are appended. Hosts that do
   * not implement it receive the compatibility replay through the individual log methods.
   */
  hydrateHistory?: (items: TranscriptItem[]) => void;
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
  /** Host status detail (e.g. “shell → workspace root”, “Ready”) without adding history. */
  onDetailUpdate?: (detail: string) => void;
  /**
   * Coarse runtime phase for the host status line. Hosts that omit it lose the phase label and
   * elapsed timer but nothing else; the detail from {@link onDetailUpdate} is unaffected.
   */
  onPhaseUpdate?: (phase: RuntimePhase) => void;
  /**
   * A new conversation turn has started (initial user input recorded). Hosts with a turn timer
   * anchor it here; steers injected mid-turn and maintenance commands never trigger this.
   */
  onTurnStart?: () => void;
  /**
   * A model call issued several tool calls at once, announced before any of them runs.
   * They execute concurrently and their blocks land in completion order, so without this
   * a host cannot tell one batch from several sequential calls. Never fired for a single
   * call: one block is trivially its own batch, and a header on every tool call is noise.
   */
  logToolRound?: (calls: number) => void;
  /**
   * Announce a tool call before its handler runs, so the host can show it as
   * running and number it in call order. Hosts that omit this get no live view
   * and fall back to numbering blocks as they complete.
   */
  logToolStart?: (start: ToolObservationStart) => ToolCallHandle;
  /**
   * Stream a running tool's own output (shell stdout/stderr) for the transient
   * live view. Chunks arrive on arbitrary byte boundaries, so the host owns line
   * assembly. Nothing here is persisted — {@link logToolBlock} commits the result.
   */
  appendToolOutput?: (toolCallId: string, chunk: string) => void;
  /** Commit a finished tool call as a collapsed, persistent block (survives turn end). */
  logToolBlock: (block: ToolObservationBlock) => void;
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
