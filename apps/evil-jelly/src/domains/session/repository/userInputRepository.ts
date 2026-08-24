import type { Message } from "@rejelly/core";
import type {
  FrozenResolvedUserInputV1,
  FrozenUserInputV1,
  ResolvedUserInputV1,
} from "../../../shared/model/prompt/frozenUserInput";
import type { SessionBlobStoreOptions } from "../journal/sessionBlobStore";
import {
  type FreezeResolvedUserInputOptions,
  freezeResolvedUserInput,
} from "../journal/userInputStorage";
import { projectFrozenUserInputRuntimeMessage } from "../projection/frozenUserInputProjection";
import { materializeMessageImageBlobs } from "./sessionMessageMaterializer";

/** Commit a transient resolver result into the canonical post-submit representation. */
export function commitResolvedUserInput(
  input: ResolvedUserInputV1,
  options: FreezeResolvedUserInputOptions = {},
): Promise<FrozenResolvedUserInputV1> {
  return freezeResolvedUserInput(input, options);
}

/** Project a canonical input record into the disposable provider-facing Message. */
export function materializeFrozenUserInputMessage(
  input: FrozenUserInputV1,
  options: SessionBlobStoreOptions = {},
): Promise<Message> {
  return materializeMessageImageBlobs(projectFrozenUserInputRuntimeMessage(input), options);
}
