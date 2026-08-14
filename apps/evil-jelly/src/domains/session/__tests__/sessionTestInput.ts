import { textPromptInput } from "../../../shared/model/prompt/promptInput";
import type { UserInputMaterializationV1 } from "../../../shared/model/prompt/userInputMaterialization";
import type { SessionRecorder } from "../recorder/sessionRecorder";

export function textMaterialization(text: string): UserInputMaterializationV1 {
  const display = { text, attachments: [] };
  return {
    version: 1,
    message: { role: "user", content: text },
    display,
    resolutions: [],
  };
}

export function recordInitialTextInput(
  recorder: SessionRecorder,
  turnId: string,
  text: string,
): Promise<void> {
  return recorder.recordUserInput(
    turnId,
    "initial",
    textPromptInput(text),
    textMaterialization(text),
  );
}
