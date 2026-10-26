import { classifyOpenAIError } from "./utils";

/** The SDK's fetch timeout ends at response headers, not at the end of generation. */
export async function awaitResponseHeaders<T>(request: PromiseLike<T>): Promise<T> {
  try {
    return await request;
  } catch (error) {
    if (classifyOpenAIError(error) === "timeout") {
      throw Object.assign(
        new Error("Timed out waiting for OpenAI response headers.", { cause: error }),
        {
          code: "ETIMEDOUT",
        },
      );
    }
    throw error;
  }
}

async function nextWithIdleTimeout<T>(
  iterator: AsyncIterator<T>,
  controller: AbortController,
  timeoutMs: number,
): Promise<IteratorResult<T>> {
  const { signal } = controller;
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      const error = Object.assign(
        new Error(`OpenAI stream idle timeout: no protocol event received for ${timeoutMs}ms.`),
        { code: "ETIMEDOUT" },
      );
      // Settle the timeout before aborting so SDK abort errors cannot hide its classification.
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });

  try {
    // Racing also bounds endpoints that fail to settle a pending read after cancellation.
    return await Promise.race([interrupted, iterator.next()]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Apply idle deadlines before protocol events are filtered into visible model output. */
export async function* withStreamIdleTimeout<T>(
  stream: AsyncIterable<T>,
  controller: AbortController,
  timeoutMs: number | undefined,
): AsyncGenerator<T> {
  if (timeoutMs === undefined) {
    yield* stream;
    return;
  }

  const iterator = stream[Symbol.asyncIterator]();
  let completed = false;
  try {
    while (true) {
      const next = await nextWithIdleTimeout(iterator, controller, timeoutMs);
      if (next.done) {
        completed = true;
        return;
      }
      // No timer runs while the consumer processes an event or applies backpressure.
      yield next.value;
    }
  } finally {
    if (!completed) {
      controller.abort("OpenAI stream closed");
      // A stuck iterator must not delay timeout/cancellation delivery. The SDK request is aborted
      // above; closing is best-effort and any late pending-read rejection is observed by the race.
      void iterator.return?.().catch(() => {});
    }
  }
}
