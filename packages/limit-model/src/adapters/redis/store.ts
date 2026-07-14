import type { ConcurrencyRule, RateLimitRule, TokenRule } from "../../rule";
import type { ConsumeResult, RateLimitStore } from "../../store";
import {
  ADJUST_SCRIPT,
  CONSUME_SCRIPT,
  LUA_RETRY_INFINITY,
  RELEASE_CONCURRENCY_SCRIPT,
  RENEW_CONCURRENCY_SCRIPT,
} from "./lua/scripts";
import type { RedisLike } from "./types";

const CONSUME_CMD = "limitConsume";
const ADJUST_CMD = "limitAdjust";
const RENEW_CONCURRENCY_CMD = "limitRenewConcurrency";
const RELEASE_CONCURRENCY_CMD = "limitReleaseConcurrency";

export interface RedisStoreOptions {
  /** Max time a request can hold a concurrency slot; after this ZREMRANGEBYSCORE cleans it (anti-deadlock). Default 60000. */
  maxConcurrencyTimeoutMs?: number;
  /** Optional key prefix prepended before the key (not part of hash tag; does not affect Redis Cluster slot). */
  prefix?: string;
  /**
   * Redis Cluster hash tag. Default "limit-model": every key routes to one slot, so any rule combination
   * can be checked atomically in one Lua script — but all limit traffic then hits a single cluster node.
   * - string: one tag for this store instance (e.g. isolate deployments, or one store per tenant).
   * - function: per-rule tag (e.g. tenant segment of rule.key) to spread tenants across slots.
   *   All rules passed to a single consume/releaseConcurrency call must map to the same tag
   *   (they run in one script); mixing tags throws before reaching Redis. This means a per-tenant
   *   tag cannot be combined with cross-tenant global rules in the same call.
   *
   * The function receives the full rule (type, limit included), but derive the tag from rule.key
   * only — rules that are checked together then share a tag naturally. Splitting tags by rule.type
   * would put rules of the same key on different slots, so they could never be combined in one call.
   *
   * @example Per-tenant tag: derive from the tenant segment of rule.key
   * ```ts
   * const store = new RedisStore(redis, { hashTag: (rule) => rule.key.split(":")[0] });
   * // One consume call, two rules of the same tenant — same tag, same slot, atomic:
   * //   { type: "concurrency", key: "tenantA" }    → {tenantA}:tenantA:concurrency
   * //   { type: "request",  key: "tenantA:gpt-4" } → {tenantA}:tenantA:gpt-4:request
   * // A tenantB call lands on a different slot — spreading the hot spot:
   * //   { type: "token", key: "tenantB:gpt-4" }    → {tenantB}:tenantB:gpt-4:token
   * ```
   */
  hashTag?: string | ((rule: RateLimitRule) => string);
}

export const DEFAULT_HASH_TAG = "limit-model";

/**
 * Redis key for rate limit dimensions. The hash tag decides the Redis Cluster slot; keys sharing a tag
 * are colocated so multi-dimensional rules (e.g. gpt:4, tenantA:gpt-4) can be checked in one Lua script.
 */
export function toRedisKey(rule: RateLimitRule, hashTag: string = DEFAULT_HASH_TAG): string {
  return `{${hashTag}}:${rule.key}:${rule.type}`;
}

/** Hash tag must be non-empty and brace-free, otherwise the {tag} slot semantics break. */
function assertValidHashTag(tag: string): string {
  if (tag === "" || tag.includes("{") || tag.includes("}")) {
    throw new Error(
      `Invalid hash tag ${JSON.stringify(tag)}: must be a non-empty string without "{" or "}"`,
    );
  }
  return tag;
}

/**
 * Production Redis implementation of RateLimitStore.
 * - Concurrency: ZSET (member=requestId, score=expiry); ZREMRANGEBYSCORE before check so killed processes don't leak slots.
 * - Token/Request: Hash token bucket; all check-then-commit in one Lua script.
 * - Keys are {hashTag}:key:type; the hash tag pins the Redis Cluster slot (see RedisStoreOptions.hashTag).
 */
export class RedisStore implements RateLimitStore {
  private readonly redis: RedisLike;
  private readonly maxConcurrencyTimeoutMs: number;
  private readonly prefix: string | undefined;
  private readonly hashTag: string | ((rule: RateLimitRule) => string);

  constructor(redisClient: RedisLike, options: RedisStoreOptions = {}) {
    this.redis = redisClient;
    this.maxConcurrencyTimeoutMs = options.maxConcurrencyTimeoutMs ?? 60000;
    this.prefix = options.prefix;
    this.hashTag =
      typeof options.hashTag === "string"
        ? assertValidHashTag(options.hashTag)
        : (options.hashTag ?? DEFAULT_HASH_TAG);
    if (typeof redisClient.defineCommand === "function") {
      redisClient.defineCommand(CONSUME_CMD, { lua: CONSUME_SCRIPT });
      redisClient.defineCommand(ADJUST_CMD, { numberOfKeys: 1, lua: ADJUST_SCRIPT });
      redisClient.defineCommand(RENEW_CONCURRENCY_CMD, { lua: RENEW_CONCURRENCY_SCRIPT });
      redisClient.defineCommand(RELEASE_CONCURRENCY_CMD, { lua: RELEASE_CONCURRENCY_SCRIPT });
    }
  }

  /**
   * Run Lua script: use defined command (EVALSHA) if available, otherwise eval.
   * When dynamicKeys is true (e.g. CONSUME/RENEW), the defined command receives (numKeys, ...args).
   * When false (e.g. ADJUST with numberOfKeys: 1), the defined command receives (...args) only.
   */
  private runScript(
    name: string,
    script: string,
    numKeys: number,
    dynamicKeys: boolean,
    ...args: (string | number)[]
  ): Promise<string> {
    const cmd = (
      this.redis as unknown as Record<string, (...a: (string | number)[]) => Promise<string>>
    )[name];
    if (typeof cmd === "function") {
      return dynamicKeys
        ? (cmd as (...a: (string | number)[]) => Promise<string>).call(this.redis, numKeys, ...args)
        : (cmd as (...a: (string | number)[]) => Promise<string>).call(this.redis, ...args);
    }
    return this.redis.eval(script, numKeys, ...args) as Promise<string>;
  }

  private tagOf(rule: RateLimitRule): string {
    return typeof this.hashTag === "function"
      ? assertValidHashTag(this.hashTag(rule))
      : this.hashTag;
  }

  private key(rule: RateLimitRule): string {
    const k = toRedisKey(rule, this.tagOf(rule));
    return this.prefix != null ? `${this.prefix}:${k}` : k;
  }

  /**
   * Rules handled in one Lua script must share a hash tag (same Redis Cluster slot), otherwise the
   * script would fail with CROSSSLOT. Throw a descriptive error before reaching Redis.
   */
  private assertSameTag(rules: RateLimitRule[]): void {
    if (typeof this.hashTag !== "function" || rules.length <= 1) return;
    const first = this.tagOf(rules[0]);
    for (const rule of rules.slice(1)) {
      const tag = this.tagOf(rule);
      if (tag !== first) {
        throw new Error(
          `Rules in one call must share a hash tag (same Redis Cluster slot), got "${first}" (key "${rules[0].key}") and "${tag}" (key "${rule.key}"). Split into separate calls or adjust the hashTag function.`,
        );
      }
    }
  }

  async consume(
    rules: RateLimitRule[],
    preDeductTokens: number,
    requestId: string,
  ): Promise<ConsumeResult> {
    if (rules.length === 0) return { allowed: true };
    this.assertSameTag(rules);

    const keys = rules.map((r) => this.key(r));
    const args: (string | number)[] = [preDeductTokens, requestId, this.maxConcurrencyTimeoutMs];
    for (const rule of rules) {
      args.push(rule.type, rule.limit, rule.type === "concurrency" ? 0 : rule.windowMs);
    }

    const resultRaw = (await this.runScript(
      CONSUME_CMD,
      CONSUME_SCRIPT,
      keys.length,
      true,
      ...keys,
      ...args,
    )) as unknown as (number | string)[];

    const allowed = resultRaw[0] === 1;
    const result: ConsumeResult = { allowed };
    if (!allowed) {
      result.reason = resultRaw[1] as "concurrency" | "token" | "request";
      if (resultRaw[2] != null) {
        const retryMs = Number(resultRaw[2]);
        result.retryAfterMs = retryMs >= LUA_RETRY_INFINITY ? Number.POSITIVE_INFINITY : retryMs;
      }
      // Lua index is 1-based; map to rules array (0-based)
      const failedIndex = Number(resultRaw[3]) - 1;
      if (failedIndex >= 0 && failedIndex < rules.length) {
        result.failedRule = rules[failedIndex];
      }
    }
    return this.attachLeaseIfNeeded(result, rules, requestId);
  }

  private attachLeaseIfNeeded(
    result: ConsumeResult,
    rules: RateLimitRule[],
    requestId: string,
  ): ConsumeResult {
    if (!result.allowed) return result;
    const concurrencyRules = rules.filter((r): r is ConcurrencyRule => r.type === "concurrency");
    if (concurrencyRules.length === 0) return result;

    const timeoutMs = this.maxConcurrencyTimeoutMs;
    const intervalMs = Math.floor(timeoutMs / 3);
    const redisKeys = concurrencyRules.map((r) => this.key(r));

    return {
      ...result,
      lease: {
        intervalMs,
        renew: async () => {
          await this.runScript(
            RENEW_CONCURRENCY_CMD,
            RENEW_CONCURRENCY_SCRIPT,
            redisKeys.length,
            true,
            ...redisKeys,
            requestId,
            timeoutMs,
          );
        },
      },
    };
  }

  async adjust(rule: TokenRule, adjustAmount: number): Promise<void> {
    if (adjustAmount === 0) return;
    const key = this.key(rule);
    await this.runScript(
      ADJUST_CMD,
      ADJUST_SCRIPT,
      1,
      false,
      key,
      adjustAmount,
      rule.limit,
      rule.windowMs,
    );
  }

  async releaseConcurrency(rules: ConcurrencyRule[], requestId: string): Promise<void> {
    if (rules.length === 0) return;
    this.assertSameTag(rules);
    const keys = rules.map((r) => this.key(r));
    await this.runScript(
      RELEASE_CONCURRENCY_CMD,
      RELEASE_CONCURRENCY_SCRIPT,
      keys.length,
      true,
      ...keys,
      requestId,
    );
  }
}
