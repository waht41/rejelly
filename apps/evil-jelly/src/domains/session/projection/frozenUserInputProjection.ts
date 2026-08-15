import {
  type FrozenUserInputV1,
  frozenUserInputImageBlobs,
  projectFrozenUserInputMessage,
  registerFrozenUserInputOrigin,
} from "../../../shared/model/prompt/frozenUserInput";
import {
  parseStoredSessionMessage,
  type StoredSessionMessage,
} from "../model/storedSessionMessage";

/** Build the disposable Message projection shared by active context, provider dispatch, and policy. */
export function projectFrozenUserInputRuntimeMessage(
  input: FrozenUserInputV1,
): StoredSessionMessage {
  const message = parseStoredSessionMessage(projectFrozenUserInputMessage(input), {
    imageBlobs: frozenUserInputImageBlobs(input),
  });
  return registerFrozenUserInputOrigin(message, input);
}
