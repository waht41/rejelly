/**
 * Minimal Redis client interface for RedisStore.
 * Compatible with ioredis, node-redis v4+, upstash-redis, or any client that exposes eval (and optionally defineCommand).
 */

export interface RedisLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  /** Optional. If present, store will use defineCommand + EVALSHA for scripts; otherwise falls back to eval. */
  defineCommand?(name: string, definition: { numberOfKeys?: number; lua: string }): void;
}
