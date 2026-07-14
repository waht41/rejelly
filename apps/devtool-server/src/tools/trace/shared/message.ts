import type { Message } from "@rejelly/core";

export function roleOf(message: unknown): string {
  const candidate = message as Partial<Message>;
  return typeof candidate.role === "string" ? candidate.role : "unknown";
}

/** Character length of a message content value: string length, else its JSON size. */
export function contentLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  return JSON.stringify(value)?.length ?? 0;
}
