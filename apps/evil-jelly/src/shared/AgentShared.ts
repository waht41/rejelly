/**
 * Shared agent-level types for child-agent props (host I/O via ../hostBindings getBinding).
 */

import type { Message } from "@rejelly/core";
import type { SessionMessageSink } from "./session/recorderPort";

export type UserReplySurface = "terminal" | "markdown_document";
export type AgentMode = "normal" | "auto";

export type UserFileAttachment = {
  type: "file";
  path: string;
};

export type UserImageAttachment = {
  type: "image";
  path: string;
  mimeType?: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  detail?: "auto" | "low" | "high";
};

export type UserAttachment = UserFileAttachment | UserImageAttachment;

/** A Skill explicitly selected by the user for one input turn. */
export type UserSkillReference = {
  qualifiedName: string;
};

/** Path-free Skill metadata a host may expose in an explicit-selection UI. */
export type UserSkillListItem = {
  qualifiedName: string;
  name: string;
  scope: "user" | "project";
  description: string;
  shortDescription?: string;
};

export type LineInputValue = {
  text: string;
  attachments?: UserAttachment[];
  /** Structured picker selections; ordinary `$text` in the prompt is never inferred as a Skill. */
  skills?: UserSkillReference[];
};

export interface ConversationAgentProps {
  /** Current user message for this turn. */
  userInput: string;
  /** Files explicitly attached to the current user turn. */
  attachments?: UserAttachment[];
  /** Skills explicitly selected for the current user turn. */
  skills?: UserSkillReference[];
  /** Prior conversation as model messages. */
  history?: Message[];
  /** Session image store used to materialize durable locators only at the model policy boundary. */
  sessionBlobRoot?: string;
  /** Where the final user-visible reply will be consumed. Defaults to terminal. */
  replySurface?: UserReplySurface;
  /** Internal top-level operation. Defaults to normal chat. */
  operation?: "chat" | "compress";
  /** Awaited durable message sink for the current top-level turn. */
  sessionRecorder?: SessionMessageSink;
  /** Stable id shared by the initial input, steers, model rounds, and tool results. */
  turnId?: string;
}

export interface ConversationAgentResult {
  /** User-visible assistant reply. */
  reply: string;
  /**
   * Current active-context delta that has not been cleared by compaction. It is not the durable
   * transcript; the awaited session recorder owns item/round persistence.
   */
  delta?: Message[];
  /** Active-context checkpoint produced by manual or mid-loop compaction. */
  compactHistory?: Message[];
  /** True when the tool loop returned through its user-abort path. */
  interrupted?: boolean;
}

/** Semantic actions the host may surface (mapped to UI in the Ink/Electron layer). */
export type WriteActionType = "accept" | "reject" | "edit" | "retry";

export interface FsWritePayload {
  type: "fs_write";
  kind: "create" | "edit" | "delete";
  filePath: string;
  unifiedDiff: string;
  /** Full proposed file contents after the change (empty string allowed for delete-only flows). */
  proposedContent: string;
  /**
   * Optional short note shown above the diff (e.g. a one-line change summary for human triage).
   */
  reviewCaption?: string;
  /** True when this write targets a path outside the workspace root. */
  outsideWorkspace?: boolean;
  /**
   * Declares which follow-up outcomes the caller can handle in this context.
   * @default ["accept", "reject"]
   */
  supportedActions?: WriteActionType[];
}

export interface FsOutsideAccessPayload {
  type: "fs_outside_access";
  mode: "read" | "write";
  targetPath: string;
  approveDir: string;
}

export interface ShellCommandPayload {
  type: "shell_command";
  command: string;
  cwd?: string;
  /** Model-declared command safety. Host policy treats this as advisory, never as a hard floor. */
  declaredSafety?: "read_only" | "reversible" | "needs_confirmation" | "dangerous";
  /** Carried from the model's tool-level safety declaration, shown to the user on "ask". */
  reason?: string;
  supportedActions?: ("accept" | "reject")[];
}

export type ToolConfirmationRequest = FsWritePayload | FsOutsideAccessPayload | ShellCommandPayload;

/**
 * Host resolves one of these after the user interacts (terminal keys, GUI, …).
 */
export type ToolConfirmationResult =
  | { action: "accept" }
  | { action: "reject" }
  | { action: "retry"; feedback: string }
  | { action: "edit"; modifiedContent: string };

/** Host must approve every disk write; show diff and block until user answers. */
export type ToolConfirmationHandler = (
  params: ToolConfirmationRequest,
) => Promise<ToolConfirmationResult>;
