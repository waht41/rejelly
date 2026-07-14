/**
 * Formatting utilities for displaying data in the UI
 */

/**
 * Format duration in milliseconds to a human-readable string
 * @param ms - Duration in milliseconds (optional)
 * @returns Formatted duration string (e.g., "123ms", "1.2s", "1m 30.5s")
 */
export function formatDuration(ms?: number): string {
  if (!ms) return "N/A";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(1);
  return `${minutes}m ${seconds}s`;
}

/**
 * Format token count from usage object
 * @param usage - Token usage object with totalTokens, promptTokens, and/or completionTokens
 * @returns Formatted token count string with locale formatting
 */
export function formatTokenCount(usage?: {
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
}): string {
  if (!usage) return "N/A";
  if (usage.totalTokens) {
    return `${usage.totalTokens.toLocaleString()}`;
  }
  if (usage.promptTokens || usage.completionTokens) {
    const prompt = usage.promptTokens || 0;
    const completion = usage.completionTokens || 0;
    return `${(prompt + completion).toLocaleString()}`;
  }
  return "N/A";
}

/**
 * Compact token count for timeline pills (e.g. 1.2k)
 */
export function formatCompactTokenCount(tokens: number): string {
  const n = Math.round(tokens);
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return `${n}`;
  const k = n / 1000;
  const rounded = k >= 10 ? Math.round(k) : Math.round(k * 10) / 10;
  const s = String(rounded).replace(/\.0$/, "");
  return `${s}k`;
}

/**
 * Pluralize a noun based on count
 * @param count - The count number
 * @param noun - The noun to pluralize
 * @param suffix - The suffix to add for plural form (default: 's')
 * @returns Formatted string like "1 agent" or "2 agents"
 */
export function pluralize(count: number, noun: string, suffix: string = "s"): string {
  return `${count} ${noun}${count !== 1 ? suffix : ""}`;
}

/**
 * Format timestamp as relative time (e.g., "2 mins ago", "Yesterday")
 * Uses tabular-nums compatible format to prevent text shifting
 */
export function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min${minutes > 1 ? "s" : ""} ago`;
  if (hours < 24) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  if (days === 1) return "Yesterday";
  return `${days} days ago`;
}
