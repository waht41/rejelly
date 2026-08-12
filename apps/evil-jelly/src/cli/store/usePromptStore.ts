/** Message-composer input state shared by the Ink editor and host input adapter. */

import { create } from "zustand";
import { SKILL_AGENT_LIMITS } from "../../domains/skills/agent/limits";
import type {
  LineInputValue,
  UserAttachment,
  UserSkillListItem,
  UserSkillReference,
} from "../../shared/host/inputBindings";

export type SkillPickerItem = UserSkillListItem;
export const MAX_SELECTED_SKILLS = SKILL_AGENT_LIMITS.explicitSkillsPerTurn;

export type DraftSeed = { id: number; value: LineInputValue };
let draftSeedId = 0;

interface PromptSessionState {
  selectedFiles: string[];
  selectedImages: string[];
  selectedSkills: UserSkillReference[];
  availableSkills: SkillPickerItem[];
  draftSeed: DraftSeed | null;
  backgroundLineHandler: ((value: LineInputValue) => void) | null;

  submitLine: (
    value: string,
    attachments?: UserAttachment[],
    skills?: UserSkillReference[],
  ) => void;
  setSelectedFiles: (paths: string[]) => void;
  setSelectedImages: (paths: string[]) => void;
  toggleSelectedFile: (path: string) => void;
  removeSelectedFile: (path: string) => void;
  clearSelectedFiles: () => void;
  addSelectedImage: (path: string) => void;
  removeSelectedImage: (path: string) => void;
  clearSelectedImages: () => void;
  setSelectedSkills: (skills: UserSkillReference[]) => void;
  clearSelectedSkills: () => void;
  setAvailableSkills: (skills: SkillPickerItem[]) => void;
  seedDraft: (value: LineInputValue) => void;
  clearDraftSeed: (id: number) => void;
  setBackgroundLineHandler: (handler: ((value: LineInputValue) => void) | null) => void;
}

export const usePromptStore = create<PromptSessionState>((set, get) => ({
  selectedFiles: [],
  selectedImages: [],
  selectedSkills: [],
  availableSkills: [],
  draftSeed: null,
  backgroundLineHandler: null,

  submitLine: (value, attachments, skills) => {
    const selectedAttachments = attachments ?? [
      ...get().selectedFiles.map((path) => ({
        type: "file" as const,
        path,
      })),
      ...get().selectedImages.map((path) => ({
        type: "image" as const,
        path,
        mimeType: "image/png" as const,
      })),
    ];
    const selectedSkills = skills ?? get().selectedSkills;
    const input: LineInputValue = {
      text: value.trim(),
      attachments: selectedAttachments,
      ...(selectedSkills.length > 0 ? { skills: selectedSkills } : {}),
    };
    get().backgroundLineHandler?.(input);
    set({
      selectedFiles: [],
      selectedImages: [],
      selectedSkills: [],
    });
  },

  setSelectedFiles: (paths) => {
    const seen = new Set<string>();
    const selectedFiles = paths.filter((path) => {
      const normalized = path.trim();
      if (!normalized || seen.has(normalized)) {
        return false;
      }
      seen.add(normalized);
      return true;
    });
    set({ selectedFiles });
  },
  setSelectedImages: (paths) => {
    const seen = new Set<string>();
    const selectedImages = paths.filter((path) => {
      const normalized = path.trim();
      if (!normalized || seen.has(normalized)) {
        return false;
      }
      seen.add(normalized);
      return true;
    });
    set({ selectedImages });
  },
  toggleSelectedFile: (path) => {
    const normalized = path.trim();
    if (!normalized) {
      return;
    }
    const selectedFiles = get().selectedFiles;
    set({
      selectedFiles: selectedFiles.includes(normalized)
        ? selectedFiles.filter((p) => p !== normalized)
        : [...selectedFiles, normalized],
    });
  },
  removeSelectedFile: (path) =>
    set({ selectedFiles: get().selectedFiles.filter((selected) => selected !== path) }),
  clearSelectedFiles: () => set({ selectedFiles: [] }),
  addSelectedImage: (path) => {
    const normalized = path.trim();
    if (!normalized) {
      return;
    }
    const selectedImages = get().selectedImages;
    if (selectedImages.includes(normalized)) {
      return;
    }
    set({ selectedImages: [...selectedImages, normalized] });
  },
  removeSelectedImage: (path) =>
    set({ selectedImages: get().selectedImages.filter((selected) => selected !== path) }),
  clearSelectedImages: () => set({ selectedImages: [] }),
  setSelectedSkills: (skills) => {
    const seen = new Set<string>();
    const selectedSkills = skills
      .filter(({ qualifiedName }) => {
        const normalized = qualifiedName.trim();
        if (!normalized || seen.has(normalized)) {
          return false;
        }
        seen.add(normalized);
        return true;
      })
      .slice(0, MAX_SELECTED_SKILLS)
      .map(({ qualifiedName }) => ({ qualifiedName: qualifiedName.trim() }));
    set({ selectedSkills });
  },
  clearSelectedSkills: () => set({ selectedSkills: [] }),
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

/** Reset UI state for a new CLI session (singleton store). */
export function resetPromptSession(): void {
  usePromptStore.setState({
    selectedFiles: [],
    selectedImages: [],
    selectedSkills: [],
    availableSkills: [],
    draftSeed: null,
    backgroundLineHandler: null,
  });
}
