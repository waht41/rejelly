export type {
  PromptAttachment,
  PromptFileAttachment,
  PromptImageAttachment,
  PromptInput,
} from "../model/prompt/promptInput";

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
export interface UserSkillReference {
  qualifiedName: string;
}

/** Path-free Skill metadata a host may expose in an explicit-selection UI. */
export interface UserSkillListItem {
  qualifiedName: string;
  name: string;
  scope: "user" | "project";
  description: string;
  shortDescription?: string;
}

export interface LineInputValue {
  text: string;
  attachments?: UserAttachment[];
  /** Structured picker selections; ordinary `$text` in the prompt is never inferred as a Skill. */
  skills?: UserSkillReference[];
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

/** User input, picker inventory, and general prompt choices supplied to the agent runtime. */
export interface PromptInputBindings {
  getInput: () => Promise<LineInputValue>;
  setAvailableSkills?: (skills: UserSkillListItem[]) => void;
  requestChoice: (request: PromptChoiceRequest) => Promise<string>;
}
