import type { PromptInput } from "../model/prompt/promptInput";

/** Path-free Skill metadata a host may expose in an explicit-selection UI. */
export interface UserSkillListItem {
  qualifiedName: string;
  name: string;
  scope: "user" | "project";
  description: string;
  shortDescription?: string;
}

/** Stable MCP server identity exposed to the semantic `$` reference picker. */
export interface UserMcpListItem {
  serverId: string;
}

/** One row in a driver-provided action menu (hotkey plus arbitrary value). */
export interface PromptChoiceOption {
  key: string;
  label: string;
  value: string;
}

/** Optional transient pane displayed while a prompt choice is open. */
export type PromptChoiceView =
  | { type: "none" }
  | { type: "diff"; text: string; caption?: string; captionTitle?: string }
  | { type: "markdown"; text: string };

export interface PromptChoiceRequest {
  message: string;
  options: PromptChoiceOption[];
  view?: PromptChoiceView;
  /** Option value resolved when the operator presses Esc; omit to make the choice non-cancelable. */
  cancelValue?: string;
}

export interface MemoryManagerEntry {
  id: string;
  scope: "user" | "project";
  title: string;
  summary: string;
  detail: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  provenance: string;
  injectedStatus?: "current" | "pending_next_epoch" | "removed_next_epoch";
}

export interface MemoryManagerRequest {
  entries: MemoryManagerEntry[];
  selectedId?: string;
  detail?: MemoryManagerEntry;
  diagnostic?: string;
  message?: string;
  canShowInExplorer: boolean;
}

export type MemoryManagerAction =
  | { action: "close" }
  | { action: "back" | "refresh" }
  | { action: "detail"; id: string }
  | { action: "show_in_explorer" };

export interface McpManagerRow {
  serverId: string;
  source: string;
  exposure: "off" | "explicit" | "always";
  selected: boolean;
  persistentAccess: boolean;
  routable: boolean;
  connection: "disabled" | "stopped" | "untrusted" | "pending" | "ready" | "failed";
  toolCount: number;
  failure?: {
    code: string;
    messageExcerpt: string;
    messageTruncated: boolean;
    detail?: string;
  };
}

export interface McpManagerToolRow {
  nativeToolName: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  approval: "ask" | "auto" | "session" | "always";
  configFingerprint: string;
  toolSchemaFingerprint: string;
}

export interface McpManagerRequest {
  rows: McpManagerRow[];
  selectedServerId?: string;
  detailServerId?: string;
  activity?: {
    serverId: string;
    label: string;
  };
  toolPanel?: {
    serverId: string;
    rows: McpManagerToolRow[];
  };
}

export type McpManagerAction =
  | { action: "close" }
  | { action: "cancel" | "refresh" }
  | { action: "toggle" | "reload" | "permissions" | "tools"; serverId: string }
  | {
      action: "set_tool_approval";
      serverId: string;
      tools: Array<{
        nativeToolName: string;
        configFingerprint: string;
        toolSchemaFingerprint: string;
      }>;
      approval: "ask" | "session" | "always";
    };

/** User input, picker inventory, and general prompt choices supplied to the agent runtime. */
export interface PromptInputBindings {
  getInput: () => Promise<PromptInput>;
  setAvailableSkills?: (skills: UserSkillListItem[]) => void;
  setAvailableMcpServers?: (servers: UserMcpListItem[]) => void;
  requestChoice: (request: PromptChoiceRequest) => Promise<string>;
  /** Rich interactive MCP manager; non-Ink hosts may omit it and use the choice fallback. */
  requestMcpManager?: (request: McpManagerRequest) => Promise<McpManagerAction>;
  /** Human-only persistent memory browser; never exposed as an Agent tool. */
  requestMemoryManager?: (request: MemoryManagerRequest) => Promise<MemoryManagerAction>;
  /** Opens the application-owned Memory Store directory in the host file manager. */
  showMemoryStoreInExplorer?: () => Promise<void>;
  /** Resolves an active MCP manager request after an asynchronous refresh completes. */
  dismissMcpManager?: () => void;
}
