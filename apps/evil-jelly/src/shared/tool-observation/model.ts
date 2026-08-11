/** Identifies one in-flight tool call from observation start until its completed block. */
export interface ToolCallHandle {
  id: string;
  /** Display number assigned in call order so parallel calls stay readable. */
  ordinal: number;
}

export interface ToolObservationStart {
  toolName: string;
  summary: string;
}

export type ToolObservationDetail = {
  type: "diff";
  text: string;
  caption?: string;
  captionTitle?: string;
};

export interface ToolObservationBlock extends ToolObservationStart {
  /** The handle issued when observation started, when the sink supports live calls. */
  id?: string;
  ordinal?: number;
  args?: string;
  detail?: ToolObservationDetail;
  preview: string;
  fullResult: string;
  ok: boolean;
}
