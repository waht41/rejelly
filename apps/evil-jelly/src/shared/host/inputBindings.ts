import type { PromptInput } from "../model/prompt/promptInput";

/** Path-free Skill metadata a host may expose in an explicit-selection UI. */
export interface UserSkillListItem {
  qualifiedName: string;
  name: string;
  scope: "user" | "project";
  description: string;
  shortDescription?: string;
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
  getInput: () => Promise<PromptInput>;
  setAvailableSkills?: (skills: UserSkillListItem[]) => void;
  requestChoice: (request: PromptChoiceRequest) => Promise<string>;
}
