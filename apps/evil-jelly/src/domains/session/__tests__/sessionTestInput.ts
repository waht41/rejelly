import type {
  FrozenUserInputV1,
  ResolvedUserInputV1,
} from "../../../shared/model/prompt/frozenUserInput";
import type { SessionRecorder } from "../recorder/sessionRecorder";

export function resolvedTextInput(text: string): ResolvedUserInputV1 {
  return { version: 1, nodes: text ? [{ kind: "text", text }] : [] };
}

export function recordInitialTextInput(
  recorder: SessionRecorder,
  turnId: string,
  text: string,
): Promise<FrozenUserInputV1> {
  return recorder.recordUserInput(turnId, "initial", resolvedTextInput(text));
}
