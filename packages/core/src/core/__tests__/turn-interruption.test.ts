import { describe, expect, it } from "vitest";
import { createDeferred } from "../../utils/deferred";
import { AbortError, isAbortError } from "../domain/errors";
import type { Message, ModelAdapter, StreamEvent } from "../domain/model";
import { createAgent } from "../engine/agent";
import { executeTurn } from "../engine/turn";
import { createAgentPolicy } from "../policy/prompt";

describe("executeTurn operation interruption", () => {
  it("stops one model operation without aborting the owning agent context", async () => {
    const started = createDeferred<void>();
    const model: ModelAdapter = {
      id: "operation-interruption-model",
      async *stream(_messages: Message[], options): AsyncGenerator<StreamEvent> {
        const signal = options?.signal;
        if (!signal) throw new Error("expected a model signal");
        started.resolve();
        await new Promise<void>((_resolve, reject) => {
          const rejectAbort = () => reject(AbortError.fromSignal(signal));
          if (signal.aborted) {
            rejectAbort();
            return;
          }
          signal.addEventListener("abort", rejectAbort, { once: true });
        });
      },
    };
    const operationController = new AbortController();
    const policy = createAgentPolicy({
      policyId: "operation-interruption-policy",
      handler: async (promptCtx) => {
        try {
          await executeTurn([{ role: "user", content: "wait" }], {
            runtime: promptCtx,
            signal: operationController.signal,
          });
          return { aborted: false };
        } catch (error) {
          if (!isAbortError(error)) throw error;
          return { aborted: true };
        }
      },
    });
    const agent = createAgent({
      id: "operation-interruption-agent",
      model,
      handler: async () => policy(),
    });

    const resultPromise = agent({});
    await started.promise;
    operationController.abort(new DOMException("stop this turn", "AbortError"));

    // If the operation signal had poisoned the owning agent context, the agent's post-handler
    // activity gate would reject here instead of preserving this structured result.
    await expect(resultPromise).resolves.toEqual({ aborted: true });
  });
});
