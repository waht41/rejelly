/**
 * SSE (Server-Sent Events) utility functions
 *
 * Provides generic SSE streaming client for handling server-sent events
 * Separates mechanism (how to stream) from policy (what to do with data)
 */

/**
 * Generic SSE POST request handler
 * @template T - Expected JSON data type from response
 * @param url - Request URL
 * @param options - Request options including body, headers, signal, and method
 * @returns AsyncGenerator yielding parsed JSON data of type T
 */
export async function* fetchSSEResponse<T = any>(
  url: string,
  options: {
    body?: any;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    method?: string; // Defaults to POST
  },
): AsyncGenerator<T> {
  const { body, headers, signal, method = "POST" } = options;

  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    // Error endpoints respond with JSON { message } - surface the human-readable part
    let message: string | undefined;
    try {
      const parsed = JSON.parse(errorText) as { message?: string };
      message = parsed?.message;
    } catch {
      // not JSON, fall through to raw text
    }
    throw new Error(message ?? `SSE Error ${response.status}: ${errorText}`);
  }

  if (!response.body) {
    throw new Error("Response body is null");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Extract line parsing logic to avoid duplication
  const parseLine = function* (line: string): Generator<T> {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (trimmed.startsWith("data: ")) {
      const dataStr = trimmed.slice(6);
      if (dataStr === "[DONE]") return; // Encountered DONE, can choose to end directly

      try {
        const data = JSON.parse(dataStr) as T;
        yield data;
      } catch (e) {
        console.warn("SSE JSON Parse Error:", e, dataStr);
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        // Fix 1: When stream ends, decode any remaining bytes (usually empty)
        buffer += decoder.decode();
        // Fix 2: Process the last remaining line in buffer (usually data: [DONE])
        if (buffer) {
          yield* parseLine(buffer);
        }
        break;
      }

      // stream: true means there may be more data, don't discard trailing bytes
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");

      // Keep the last incomplete fragment
      buffer = lines.pop() || "";

      for (const line of lines) {
        yield* parseLine(line);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
