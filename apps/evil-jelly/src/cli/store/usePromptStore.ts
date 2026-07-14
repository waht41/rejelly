/**
 * Transient view (diff, markdown, …) and prompt (line / confirm) as separate slices — host uses getState() outside React.
 */

import { create } from "zustand";
import type { LineInputValue, UserAttachment } from "../../shared/AgentShared";

export type TransientView =
  | { type: "none" }
  | { type: "diff"; text: string; caption?: string; captionTitle?: string }
  | { type: "markdown"; text: string };

export type ActionMenuOption = { key: string; label: string; value: string };

export type PromptSnapshot =
  | { type: "idle" }
  | { type: "line"; label: string }
  | { type: "confirm"; message: string; defaultYes: boolean }
  | { type: "actionMenu"; message: string; options: ActionMenuOption[] };

type Inner =
  | { type: "idle" }
  | { type: "line"; label: string; resolve: (value: string) => void }
  | { type: "confirm"; message: string; initial: boolean; resolve: (ok: boolean) => void }
  | {
      type: "actionMenu";
      message: string;
      options: ActionMenuOption[];
      resolve: (value: string) => void;
    };

function toPublic(inner: Inner): PromptSnapshot {
  switch (inner.type) {
    case "idle":
      return { type: "idle" };
    case "line":
      return { type: "line", label: inner.label };
    case "confirm":
      return { type: "confirm", message: inner.message, defaultYes: inner.initial };
    case "actionMenu":
      return { type: "actionMenu", message: inner.message, options: inner.options };
  }
}

const idleInner: Inner = { type: "idle" };
export type DraftSeed = { id: number; value: LineInputValue };
let draftSeedId = 0;

interface PromptSessionState {
  view: TransientView;
  prompt: PromptSnapshot;
  _inner: Inner;
  selectedFiles: string[];
  selectedImages: string[];
  draftSeed: DraftSeed | null;
  backgroundLineHandler: ((value: LineInputValue) => void) | null;

  /** Replace transient view only (e.g. clear, or show markdown without a prompt). */
  setView: (view: TransientView) => void;

  /** One line of text; clears transient view; resolves on submit. */
  requestLine: (label: string) => Promise<string>;
  submitLine: (value: string, attachments?: UserAttachment[]) => void;
  setSelectedFiles: (paths: string[]) => void;
  setSelectedImages: (paths: string[]) => void;
  toggleSelectedFile: (path: string) => void;
  removeSelectedFile: (path: string) => void;
  clearSelectedFiles: () => void;
  addSelectedImage: (path: string) => void;
  removeSelectedImage: (path: string) => void;
  clearSelectedImages: () => void;
  seedDraft: (value: LineInputValue) => void;
  clearDraftSeed: (id: number) => void;
  setBackgroundLineHandler: (handler: ((value: LineInputValue) => void) | null) => void;

  /**
   * Y/n confirm. Pass `view` to set transient view and confirm in one update (recommended for diff + confirm).
   * If `view` is omitted, the current `view` is kept.
   */
  requestConfirm: (message: string, initial?: boolean, view?: TransientView) => Promise<boolean>;
  submitConfirm: (ok: boolean) => void;

  /** Multi-choice menu (hotkeys); resolves to the selected option's `value`. */
  requestActionMenu: (
    message: string,
    options: ActionMenuOption[],
    view?: TransientView,
  ) => Promise<string>;
  submitActionChoice: (value: string) => void;
}

export const usePromptStore = create<PromptSessionState>((set, get) => ({
  view: { type: "none" },
  prompt: { type: "idle" },
  _inner: idleInner,
  selectedFiles: [],
  selectedImages: [],
  draftSeed: null,
  backgroundLineHandler: null,

  setView: (view) => set({ view }),

  requestLine: (label) =>
    new Promise((resolve) => {
      set({
        view: { type: "none" },
        _inner: { type: "line", label, resolve },
        prompt: { type: "line", label },
      });
    }),

  submitLine: (value, attachments) => {
    const inner = get()._inner;
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
    const input: LineInputValue = { text: value.trim(), attachments: selectedAttachments };
    if (inner.type !== "line") {
      get().backgroundLineHandler?.(input);
      return;
    }
    const { resolve } = inner;
    set({
      _inner: idleInner,
      prompt: toPublic(idleInner),
      selectedFiles: [],
      selectedImages: [],
    });
    resolve(input.text);
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
  seedDraft: (value) =>
    set({
      draftSeed: {
        id: ++draftSeedId,
        value: {
          text: value.text,
          attachments: value.attachments ? [...value.attachments] : undefined,
        },
      },
    }),
  clearDraftSeed: (id) =>
    set((state) => (state.draftSeed?.id === id ? { draftSeed: null } : state)),
  setBackgroundLineHandler: (handler) => set({ backgroundLineHandler: handler }),

  requestConfirm: (message, initial = true, viewSlice) =>
    new Promise((resolve) => {
      set({
        ...(viewSlice !== undefined ? { view: viewSlice } : {}),
        _inner: { type: "confirm", message, initial, resolve },
        prompt: { type: "confirm", message, defaultYes: initial },
      });
    }),

  submitConfirm: (ok) => {
    const inner = get()._inner;
    if (inner.type !== "confirm") {
      return;
    }
    const { resolve } = inner;
    set({
      view: { type: "none" },
      _inner: idleInner,
      prompt: toPublic(idleInner),
    });
    resolve(ok);
  },

  requestActionMenu: (message, options, viewSlice) =>
    new Promise((resolve) => {
      set({
        ...(viewSlice !== undefined ? { view: viewSlice } : {}),
        _inner: { type: "actionMenu", message, options, resolve },
        prompt: { type: "actionMenu", message, options },
      });
    }),

  submitActionChoice: (value) => {
    const inner = get()._inner;
    if (inner.type !== "actionMenu") {
      return;
    }
    const allowed = inner.options.some((o) => o.value === value);
    if (!allowed) {
      return;
    }
    const { resolve } = inner;
    set({
      view: { type: "none" },
      _inner: idleInner,
      prompt: toPublic(idleInner),
    });
    resolve(value);
  },
}));

/** Reset UI state for a new CLI session (singleton store). */
export function resetPromptSession(): void {
  usePromptStore.setState({
    view: { type: "none" },
    prompt: { type: "idle" },
    _inner: idleInner,
    selectedFiles: [],
    selectedImages: [],
    draftSeed: null,
    backgroundLineHandler: null,
  });
}
