/** Semantic actions the host may surface for a proposed filesystem write. */
export type WriteActionType = "accept" | "reject" | "edit" | "retry";

export type ExternalFileAccess = "read" | "scan" | "write";

export interface FsWritePayload {
  type: "fs_write";
  kind: "create" | "edit" | "delete";
  filePath: string;
  unifiedDiff: string;
  /** Full proposed file contents after the change (empty string allowed for delete-only flows). */
  proposedContent: string;
  /** Optional short note shown above the diff. */
  reviewCaption?: string;
  /** True when this write targets a path outside the workspace root. */
  outsideWorkspace?: boolean;
  /** Declares which follow-up outcomes the caller can handle in this context. */
  supportedActions?: WriteActionType[];
}

export interface FsOutsideAccessPayload {
  type: "fs_outside_access";
  access: ExternalFileAccess;
  targetPath: string;
  grantRoot: string;
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

/** Ephemeral approval projection; routing still uses the domain-owned structured identity. */
export interface McpCallConfirmationPayload {
  type: "mcp_call";
  tool: {
    serverId: string;
    nativeToolName: string;
  };
  configFingerprint: string;
  toolSchemaFingerprint: string;
  /** Exact config policy matched this tool; Auto mode may allow only this call. */
  autoApprovedByPolicy: boolean;
  arguments: Record<string, unknown>;
}

export interface McpAccessConfirmationPayload {
  type: "mcp_access";
  serverId: string;
  source: string;
  configFingerprint: string;
  requiresTrust: boolean;
  reason?: string;
}

export type ToolConfirmationRequest =
  | FsWritePayload
  | FsOutsideAccessPayload
  | ShellCommandPayload
  | McpAccessConfirmationPayload
  | McpCallConfirmationPayload;

export type ToolConfirmationResult =
  | { action: "accept"; scope?: "once" | "session" | "always" }
  | { action: "reject" }
  | { action: "retry"; feedback: string }
  | { action: "edit"; modifiedContent: string };

export type ToolConfirmationHandler = (
  params: ToolConfirmationRequest,
) => Promise<ToolConfirmationResult>;

/** Model-independent preview used by the memory confirmation surface. */
export interface MemoryMutationEntryPreview {
  id: string;
  scope: "user" | "project";
  title: string;
  summary: string;
  detail: string;
  revision: number;
}

export interface MemoryMutationConfirmationPayload {
  type: "memory_mutation";
  operation: "add" | "update" | "delete";
  scope: "user" | "project";
  id: string;
  expectedRevision: number;
  before?: MemoryMutationEntryPreview;
  after?: MemoryMutationEntryPreview;
  proposalSha256: string;
  source: {
    source: "agent_tool" | "slash_command";
    sessionId?: string;
    turnId?: string;
  };
}

export type MemoryConfirmationResult =
  | { action: "accept" }
  | { action: "reject" }
  | { action: "unavailable"; reason: string };

export type MemoryConfirmationHandler = (
  params: MemoryMutationConfirmationPayload,
) => Promise<MemoryConfirmationResult>;

/** Human or policy decision boundaries for operations that require confirmation. */
export interface ToolConfirmationBindings {
  confirmTool: ToolConfirmationHandler;
  /** Independent gate for persistent memory; auto/headless hosts must not accept it implicitly. */
  requestMemoryConfirmation?: MemoryConfirmationHandler;
}
