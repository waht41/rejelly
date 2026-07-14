/**
 * Effect runtime internals.
 *
 * This module owns stream consumer lifecycle and event dispatch for agent
 * execution. Public user-facing APIs live in primitives/effect.ts.
 */

import { StreamEventDispatcher } from "../../utils/stream-event-dispatcher";
import { runGeneratorInContext } from "../context/accessor";
import { getContextStore } from "../context/store";
import type { AgentContext, StreamRuntimeState } from "../context/type";
import type { AgentStreamEvent } from "../domain/stream";
import { logger } from "../shared/logger/instance";

function createStreamRuntime(): StreamRuntimeState {
  return {
    dispatcher: new StreamEventDispatcher<AgentStreamEvent>(),
    controller: new AbortController(),
    consumerTasks: [],
    startedConsumerCount: 0,
  };
}

function createCombinedAbortSignal(
  generationSignal: AbortSignal,
  userSignal?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  if (!userSignal) {
    return { signal: generationSignal, cleanup: () => {} };
  }

  const controller = new AbortController();
  const abortFromGeneration = () => controller.abort(generationSignal.reason);
  const abortFromUser = () => controller.abort(userSignal.reason);

  if (generationSignal.aborted) {
    controller.abort(generationSignal.reason);
  } else if (userSignal.aborted) {
    controller.abort(userSignal.reason);
  } else {
    generationSignal.addEventListener("abort", abortFromGeneration, { once: true });
    userSignal.addEventListener("abort", abortFromUser, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      generationSignal.removeEventListener("abort", abortFromGeneration);
      userSignal.removeEventListener("abort", abortFromUser);
    },
  };
}

function startPendingStreamConsumers(ctx: AgentContext, runtime: StreamRuntimeState): void {
  while (runtime.startedConsumerCount < ctx.draft.streamConsumers.length) {
    const registration = ctx.draft.streamConsumers[runtime.startedConsumerCount];
    runtime.startedConsumerCount += 1;
    const { consumer, options } = registration;
    const { signal, cleanup } = createCombinedAbortSignal(
      runtime.controller.signal,
      options.signal,
    );

    const rawConsumerTask = Promise.resolve(
      getContextStore().run(
        ctx,
        async () => {
          try {
            const stream = runGeneratorInContext(ctx, runtime.dispatcher.subscribe(0, { signal }));
            await consumer(stream);
          } finally {
            cleanup();
          }
        },
        { incDepth: false, parentContext: ctx.parentContext ?? null },
      ),
    );

    const awaitOnEnd = options.awaitOnEnd ?? true;

    const consumerTask = rawConsumerTask.catch((error) => {
      if (awaitOnEnd) {
        logger.warn("onStream consumer error:", error);
      }
    });

    runtime.consumerTasks.push({
      promise: consumerTask,
      awaitOnEnd,
    });
  }
}

export function ensureGenerationStreamRuntime(ctx: AgentContext): StreamRuntimeState | undefined {
  if (ctx.draft.streamConsumers.length === 0) {
    return undefined;
  }

  if (!ctx.draft.streamRuntime) {
    ctx.draft.streamRuntime = createStreamRuntime();
  }

  startPendingStreamConsumers(ctx, ctx.draft.streamRuntime);
  return ctx.draft.streamRuntime;
}

export function emitStreamEvent(ctx: AgentContext, event: AgentStreamEvent): void {
  const runtime = ensureGenerationStreamRuntime(ctx);
  runtime?.dispatcher.append(event);
}

export async function stopGenerationStreams(ctx: AgentContext, reason?: unknown): Promise<void> {
  const runtime = ctx.draft.streamRuntime;
  if (!runtime) {
    return;
  }

  ctx.draft.streamRuntime = undefined;
  runtime.controller.abort(reason);
  runtime.dispatcher.close();
  const awaitedTasks = runtime.consumerTasks
    .filter((task) => task.awaitOnEnd)
    .map((task) => task.promise);
  await Promise.allSettled(awaitedTasks);
}
