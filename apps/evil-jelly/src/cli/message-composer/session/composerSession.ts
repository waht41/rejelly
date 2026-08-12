/** External session bridge between the host bindings and the mounted composer. */

import { create } from "zustand";
import { SKILL_AGENT_LIMITS } from "../../../domains/skills/agent/limits";
import type { LineInputValue, UserSkillListItem } from "../../../shared/host/inputBindings";

export type SkillPickerItem = UserSkillListItem;
export const MAX_SELECTED_SKILLS = SKILL_AGENT_LIMITS.explicitSkillsPerTurn;

export type DraftSeed = { id: number; value: LineInputValue };
let draftSeedId = 0;

interface ComposerSessionState {
  availableSkills: SkillPickerItem[];
  draftSeed: DraftSeed | null;
  backgroundLineHandler: ((value: LineInputValue) => void) | null;

  submitLine: (value: LineInputValue) => void;
  setAvailableSkills: (skills: SkillPickerItem[]) => void;
  seedDraft: (value: LineInputValue) => void;
  clearDraftSeed: (id: number) => void;
  setBackgroundLineHandler: (handler: ((value: LineInputValue) => void) | null) => void;
}

export const useComposerSession = create<ComposerSessionState>((set, get) => ({
  availableSkills: [],
  draftSeed: null,
  backgroundLineHandler: null,

  submitLine: (value) => get().backgroundLineHandler?.(value),
  setAvailableSkills: (skills) =>
    set({
      availableSkills: [...skills].sort((left, right) =>
        left.qualifiedName.localeCompare(right.qualifiedName, "en"),
      ),
    }),
  seedDraft: (value) =>
    set({
      draftSeed: {
        id: ++draftSeedId,
        value: {
          text: value.text,
          attachments: value.attachments ? [...value.attachments] : undefined,
          ...(value.skills?.length ? { skills: [...value.skills] } : {}),
        },
      },
    }),
  clearDraftSeed: (id) =>
    set((state) => (state.draftSeed?.id === id ? { draftSeed: null } : state)),
  setBackgroundLineHandler: (handler) => set({ backgroundLineHandler: handler }),
}));

/** Reset the external bridge for a new CLI session. */
export function resetComposerSession(): void {
  useComposerSession.setState({
    availableSkills: [],
    draftSeed: null,
    backgroundLineHandler: null,
  });
}
