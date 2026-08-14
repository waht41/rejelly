/** External session bridge between the host bindings and the mounted composer. */

import { create } from "zustand";
import { SKILL_AGENT_LIMITS } from "../../../domains/skills/agent/limits";
import type { UserSkillListItem } from "../../../shared/host/inputBindings";
import { releasePromptResources } from "../../../shared/host/promptResourceLifecycle";
import { copyPromptInput, type PromptInput } from "../../../shared/model/prompt/promptInput";

export type SkillPickerItem = UserSkillListItem;
export const MAX_SELECTED_SKILLS = SKILL_AGENT_LIMITS.explicitSkillsPerTurn;

export type DraftSeed = { id: number; value: PromptInput };
let draftSeedId = 0;

interface ComposerSessionState {
  availableSkills: SkillPickerItem[];
  draftSeed: DraftSeed | null;
  backgroundLineHandler: ((value: PromptInput) => void) | null;

  submitLine: (value: PromptInput) => void;
  setAvailableSkills: (skills: SkillPickerItem[]) => void;
  seedDraft: (value: PromptInput) => void;
  clearDraftSeed: (id: number) => void;
  setBackgroundLineHandler: (handler: ((value: PromptInput) => void) | null) => void;
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
  seedDraft: (value) => {
    const replaced = get().draftSeed;
    set({
      draftSeed: {
        id: ++draftSeedId,
        value: copyPromptInput(value),
      },
    });
    if (replaced) void releasePromptResources(replaced.value).catch(() => undefined);
  },
  clearDraftSeed: (id) =>
    set((state) => (state.draftSeed?.id === id ? { draftSeed: null } : state)),
  setBackgroundLineHandler: (handler) => set({ backgroundLineHandler: handler }),
}));

/** Reset the external bridge for a new CLI session. */
export function resetComposerSession(): void {
  const discarded = useComposerSession.getState().draftSeed;
  useComposerSession.setState({
    availableSkills: [],
    draftSeed: null,
    backgroundLineHandler: null,
  });
  if (discarded) void releasePromptResources(discarded.value).catch(() => undefined);
}
