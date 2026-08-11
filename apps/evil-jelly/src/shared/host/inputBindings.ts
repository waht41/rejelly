import type { AgentMode, LineInputValue, UserSkillListItem } from "../AgentShared";

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

/** User input, picker inventory, mode, and general prompt choices supplied to the agent runtime. */
export interface PromptInputBindings {
  getInput: () => Promise<LineInputValue>;
  setAvailableSkills?: (skills: UserSkillListItem[]) => void;
  getAgentMode?: () => AgentMode;
  requestChoice: (
    message: string,
    options: PromptChoiceOption[],
    view?: PromptChoiceView,
  ) => Promise<string>;
}
