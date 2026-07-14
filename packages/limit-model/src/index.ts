/**
 * @rejelly/limit-model
 * WithLimit core API: types and contracts for rate limiting (token / concurrency / request).
 * No store implementation; implement RateLimitStore for Memory or Redis.
 *
 * @packageDocumentation
 */

export { MemoryStore } from "./adapters/memory/store";
export type { RedisStoreOptions } from "./adapters/redis/store";
export { DEFAULT_HASH_TAG, RedisStore, toRedisKey } from "./adapters/redis/store";
export type { RedisLike } from "./adapters/redis/types";
export { defaultCalculatePreDeduct } from "./core/estimators";
export {
  DEFAULT_RETRY_AFTER_BUFFER_MS,
  type LimitAdapterLike,
  type LimitMiddleware,
  RateLimitExceededError,
  TokenLimitExceededError,
  type WithLimitOptions,
  withLimit,
} from "./core/middleware";
export type {
  ConcurrencyRule,
  RateLimitRule,
  RateLimitType,
  RequestRule,
  TokenRule,
} from "./rule";
export type { SimpleLimitOptions } from "./simple-limit";
export { withSimpleLimit } from "./simple-limit";
export type { ConsumeResult, RateLimitStore } from "./store";
