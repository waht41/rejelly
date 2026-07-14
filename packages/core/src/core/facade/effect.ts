import { getCurrentContext } from "../context/accessor";
import { AfterPromptAgentError } from "../domain/errors";
import type { OnStreamConsumer, OnStreamOptions } from "../domain/stream";

/**
 * Listen to agent-level streaming events via an async generator.
 *
 * Consumers are multicast subscribers over the current generation's event log.
 * They are started lazily when the first stream event is emitted and are
 * automatically aborted when the generation ends.
 *
 * **Must be called BEFORE `promptAgent()` / `promptChat()`!**
 */
export function onStream(consumer: OnStreamConsumer, options: OnStreamOptions = {}): void {
  const ctx = getCurrentContext();
  if (ctx.draft.prompted) {
    throw new AfterPromptAgentError("onStream");
  }
  ctx.draft.streamConsumers.push({ consumer, options });
}
