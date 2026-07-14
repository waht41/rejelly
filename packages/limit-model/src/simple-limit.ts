import { MemoryStore } from "./adapters/memory/store";
import type { LimitAdapterLike, LimitMiddleware } from "./core/middleware";
import { withLimit } from "./core/middleware";
import type { RateLimitRule } from "./rule";
import type { RateLimitStore } from "./store";

export interface SimpleLimitOptions {
  /** Max requests per minute (RPM) */
  rpm?: number;
  /** Max tokens per minute (TPM) */
  tpm?: number;
  /** Max concurrent requests */
  concurrency?: number;
  /** Unique scope key so multiple models do not share the same limit keys. Default "default-model" */
  key?: string;
  /** Optional store. If not provided, creates a new in-memory store for this middleware instance. */
  store?: RateLimitStore;
}

/**
 * Simplified limit middleware: maps rpm/tpm/concurrency to RateLimitRule[] and calls withLimit.
 * For quick integration when you don't need per-rule keys or custom rules.
 */
export function withSimpleLimit<Adapter extends LimitAdapterLike>(
  options: SimpleLimitOptions,
): LimitMiddleware<Adapter> {
  const store = options.store ?? new MemoryStore();
  const keyPrefix = options.key ?? "default-model";
  const rules: RateLimitRule[] = [];

  if (options.rpm !== undefined) {
    rules.push({ type: "request", key: `${keyPrefix}:rpm`, limit: options.rpm, windowMs: 60000 });
  }
  if (options.tpm !== undefined) {
    rules.push({ type: "token", key: `${keyPrefix}:tpm`, limit: options.tpm, windowMs: 60000 });
  }
  if (options.concurrency !== undefined) {
    rules.push({
      type: "concurrency",
      key: `${keyPrefix}:concurrency`,
      limit: options.concurrency,
    });
  }

  if (rules.length === 0) {
    throw new Error("withSimpleLimit requires at least one limit rule (rpm, tpm, or concurrency).");
  }

  return withLimit({ store, rules });
}
