import { equipResource, expectResource, isContextNotFoundError } from "@rejelly/core";
import type { ToolObservationBlock } from "./model";

const TOOL_OBSERVATION_RECORDER_KEY = "evil_jelly:tool_observation_recorder";

export interface ToolObservationRecorder {
  record(toolCallId: string, block: ToolObservationBlock): Promise<void>;
}

export async function equipToolObservationRecorder(
  recorder: ToolObservationRecorder | undefined,
): Promise<void> {
  if (!recorder) return;
  await equipResource(TOOL_OBSERVATION_RECORDER_KEY, {
    create: async () => recorder,
    deps: [recorder],
    expose: true,
  });
}

export function getToolObservationRecorder(): ToolObservationRecorder | undefined {
  try {
    return expectResource<ToolObservationRecorder>(TOOL_OBSERVATION_RECORDER_KEY, {
      optional: true,
    });
  } catch (error) {
    // Middleware unit tests and direct tool calls may intentionally run without an agent context.
    if (isContextNotFoundError(error)) return undefined;
    throw error;
  }
}
