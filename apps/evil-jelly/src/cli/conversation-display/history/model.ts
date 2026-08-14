import type { ToolObservationDetail } from "../../../shared/tool-observation/model";

export type ToolBlock = {
  id?: string;
  toolName: string;
  summary: string;
  args?: string;
  detail?: ToolObservationDetail;
  preview: string;
  fullResult: string;
  ok: boolean;
  ordinal?: number;
};

/** Session header shown at the top of a fresh view (startup and after `/clear`). */
export type SessionBanner = {
  model: string;
  dir: string;
  version: string;
};

/** Reviewed diff committed to scrollback history (so the user can scroll back to it later). */
export type DiffBlockDetail = {
  text: string;
  caption?: string;
  captionTitle?: string;
};

export type Turn =
  | { id: string; type: "user"; content: string }
  /** `oneLine`: a notice, truncated to a single row rather than wrapped. */
  | { id: string; type: "system"; content: string; oneLine?: boolean }
  | { id: string; type: "assistant"; content: string; hidden?: boolean }
  | { id: string; type: "assistant_stream"; content: string; final?: boolean }
  /**
   * Heads the tool blocks one model call issued together. Only written for two or more:
   * a single block is trivially its own batch, so a header on every call would be noise,
   * and the rule stays unambiguous — a block with no header above it is a batch of one.
   */
  | { id: string; type: "tool_round"; calls: number }
  | { id: string; type: "tool"; content: string; tool: ToolBlock }
  | { id: string; type: "diff"; diff: DiffBlockDetail }
  | { id: string; type: "banner"; banner: SessionBanner };
