/**
 * Token estimators: business-specific logic for pre-deduct token calculation.
 * Developers can pass custom functions to withLimit(options.calculatePreDeduct) based on their message shape.
 */

/**
 * Default pre-deduct: total input text length / 4 (rough token estimate).
 * Handles messages as { content?: string | Array<{ type?: string; text?: string }> }.
 * For other message formats, pass a custom calculatePreDeduct in WithLimitOptions.
 */
export function defaultCalculatePreDeduct(messages: unknown[]): number {
  let len = 0;
  for (const m of messages) {
    const msg = m as { content?: string | Array<{ type?: string; text?: string }> };
    const c = msg?.content;
    if (typeof c === "string") {
      len += c.length;
    } else if (Array.isArray(c)) {
      for (const p of c) {
        if (p?.type === "text" && typeof p.text === "string") len += p.text.length;
      }
    }
  }
  return Math.ceil(len / 4);
}
