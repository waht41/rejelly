import { concatenatePromptInputs, type PromptInput } from "../../shared/model/prompt/promptInput";

/** Collapse buffered steers into the single rich draft restored after cancellation. */
export function mergeSteersIntoDraft(steers: readonly PromptInput[]): PromptInput | undefined {
  return steers.length > 0 ? concatenatePromptInputs(steers) : undefined;
}
