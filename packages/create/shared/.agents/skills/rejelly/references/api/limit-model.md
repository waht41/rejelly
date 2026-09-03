# Limit Model (Rate Limiting)

`@rejelly/limit-model` provides model rate-limiting middleware, mountable on any `ModelAdapter` via [`augmentModel`](/en/api/core#augmentmodel-model-middlewares):

- **`withSimpleLimit(options)`**: Simplified wrapper for rpm / tpm / concurrency, quick to set up.
- **`withLimit(options)`**: Rule-level, each rule has its own key, supports multi-dimensional combinations and pluggable Store.

Rate limiting uses a **fast-fail** strategy: exceeding the limit throws an error directly ([error types](#error-types)), no queuing, no "rate-limit waiting" events emitted.

## `withSimpleLimit(options)`

```typescript
import { augmentModel } from '@rejelly/core';
import { withSimpleLimit } from '@rejelly/limit-model';

const simpleLimitedModel = augmentModel(baseModel, [
  withSimpleLimit({
    rpm: 60,
    tpm: 90000,
    concurrency: 5,
    key: 'my-model',
    store: undefined,  // if omitted, creates a new MemoryStore for this middleware
  }),
]);
```

**Options (SimpleLimitOptions):**

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `rpm` | `number` | ❌ | - | Max requests per minute |
| `tpm` | `number` | ❌ | - | Max tokens per minute |
| `concurrency` | `number` | ❌ | - | Max concurrency |
| `key` | `string` | ❌ | `"default-model"` | Unique identifier for rate-limit scope, prevents rule overlap across models |
| `store` | `RateLimitStore` | ❌ | New independent MemoryStore | Custom storage (e.g., RedisStore); if omitted, each middleware instance creates its own in-memory store |

At least one of `rpm`, `tpm`, or `concurrency` must be provided. Internally maps to corresponding Rules (key format: `${key}:rpm`) and routes through `withLimit`.

## `withLimit(options)`

Rule-level rate limiting: each rule has its own `key`, and a single request can be constrained by multiple rules simultaneously (e.g., tenant-global concurrency + per-model RPM).

```typescript
import { augmentModel } from '@rejelly/core';
import { withLimit, MemoryStore, RedisStore } from '@rejelly/limit-model';

const store = new MemoryStore();  // or new RedisStore(redisClient)
const ruleLimitedModel = augmentModel(baseModel, [
  withLimit({
    store,
    rules: [
      // Global gpt4 level
      { type: 'concurrency', key: 'gpt4', limit: 100 },
      { type: 'request', key: 'gpt4', limit: 500, windowMs: 60000 },
      { type: 'token', key: 'gpt4', limit: 500000, windowMs: 60000 },
      // Tenant A dimension
      { type: 'concurrency', key: 'tenant:A', limit: 10 },
      { type: 'request', key: 'tenant:A:gpt4', limit: 50, windowMs: 60000 },
      { type: 'token', key: 'tenant:A:gpt4', limit: 90000, windowMs: 60000 },
    ],
  }),
]);
```

**Options (WithLimitOptions):**

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `store` | `RateLimitStore` | ✅ | - | Injected storage (MemoryStore / RedisStore / custom implementation) |
| `rules` | `RateLimitRule[]` | ✅ | - | Array of rate-limit rules, checked in array order — first exceeded limit causes failure |
| `calculatePreDeduct` | `(messages) => number` | ❌ | Input text length / 4 | Token pre-deduction estimation: pre-deducts before the request, refunds excess after streaming completes based on actual usage |
| `retryAfterBufferMs` | `number` | ❌ | `100` | Buffer added to the store's returned `retryAfterMs`, preventing clients from hitting the limit again when retrying exactly on time |

**Rule Types:**

| Type | Description | Fields |
|------|-------------|--------|
| `ConcurrencyRule` | Concurrency count | `type: 'concurrency'`, `key`, `limit` (no windowMs) |
| `RequestRule` | Requests per minute (RPM) | `type: 'request'`, `key`, `limit`, `windowMs` |
| `TokenRule` | Tokens per minute (TPM) | `type: 'token'`, `key`, `limit`, `windowMs` |

## Store

- **MemoryStore**: Single-process in-memory, suitable for development or **single-process** deployment.
- **RedisStore**: Production use, requires a `RedisLike` client (e.g., ioredis). Concurrency uses ZSET (member=requestId, score=expiration time), self-healing via `ZREMRANGEBYSCORE` in Lua after a process kill. Token/Request use Hash buckets. Key format is `{hashTag}:key:type` — **hash tag** determines the Redis Cluster slot: defaults to `limit-model` so all keys share the same slot, and any rule combination can be checked atomically within a single Lua script.

> **⚠️ MemoryStore is not suitable for multi-process**
>
> MemoryStore data resides **in-process memory** and is not shared across processes. In **PM2 multi-process / cluster mode, multi-instance deployments, Serverless multi-instance** scenarios, each process counts independently — rate limits are effectively multiplied (e.g., 4 workers = 4x effective concurrency), making rate limiting ineffective. Such deployments **must** use **RedisStore** (or another cross-process shared Store).
>
> **⚠️ RedisStore has a single-point bottleneck**
>
> **Rate limiting implementation note**: RedisStore relies internally on Redis Lua scripts + same-slot keys for consistency. With the default fixed hash tag, **all** rate-limit traffic concentrates on a single node (Lua executes single-threaded, equivalent to a single core). Do not use in very high QPS scenarios (typically QPS > 10K). In multi-tenant scenarios, use the `hashTag` function to distribute tenants across different slots (see options and example below), at the cost that cross-tenant global rules cannot be mixed within the same check.

**RedisStore Options (RedisStoreOptions):**

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `maxConcurrencyTimeoutMs` | `number` | ❌ | `60000` | Max hold time for a concurrency slot; cleaned up by Lua on timeout (prevents deadlock after process kill) |
| `prefix` | `string` | ❌ | - | Key prefix (does not participate in hash tag, does not affect slot) |
| `hashTag` | `string \| (rule) => string` | ❌ | `"limit-model"` | Redis Cluster hash tag. string: entire store shares one tag (e.g., isolate deployments). function: compute tag per rule (recommend deriving from `rule.key` only, e.g., tenant segment), distributing tenants across slots. **All rules in the same check must compute to the same tag** — mixing tags throws an error before sending to Redis |

```typescript
// Multi-tenant hot-spot distribution: derive hash tag from the tenant segment of rule.key
// (the split rule must match your key naming convention)
const store = new RedisStore(redisClient, {
  hashTag: (rule) => rule.key.split(':')[0],
});
// Same check, same tenant's two rules — same tag, same slot, atomic ✓
//   { type: 'concurrency', key: 'tenantA' }    → {tenantA}:tenantA:concurrency
//   { type: 'request', key: 'tenantA:gpt-4' }  → {tenantA}:tenantA:gpt-4:request
// tenantB's check lands on a different slot — hot-spot distributed
//   { type: 'token', key: 'tenantB:gpt-4' }    → {tenantB}:tenantB:gpt-4:token
```

After partitioning by tenant tag, the atomic unit shrinks from "entire store" to "rule set with the same tag": cross-tenant global rules (e.g., global `gpt4` concurrency + tenant rules) can no longer be mixed in the same check — either drop the global rule, or split into two checks and accept non-atomicity.

## Multi-Tenant Full Example

Group by `tenantId` into `modelRegistry`, `withLimit` key uses tenant id, quotas read from `tenantLimits`; store uses RedisStore with per-tenant hash tag, distributing each tenant's rate-limit keys across different Redis Cluster slots.

```typescript
import { augmentModel, runWith, type ModelAdapter } from '@rejelly/core';
import { withLimit, RedisStore } from '@rejelly/limit-model';

// ⚠️ The split rule must match your key naming convention: this example's keys start with the tenant id
//    (`tenantId`, `${tenantId}:cheap`), so taking the first segment yields the tenant.
//    If copied from the withLimit example above with 'tenant:A:gpt4' naming, all tenants would compute
//    the same tag "tenant" and partitioning would fail.
//    After partitioning by tag, a single withLimit's rules must not mix cross-tenant global rules
//    (e.g., global 'gpt4') — different tags will throw directly.
const tenantStore = new RedisStore(redisClient, {
  hashTag: (rule) => rule.key.split(':')[0],
});

function getModelRegistry(tenantId: string): Record<string, ModelAdapter> {
  const expensiveBase = createOpenAIAdapter({ modelId: 'gpt-5.6-sol' });
  const cheapBase = createOpenAIAdapter({ modelId: 'gpt-5.6-luna' });
  const limits = tenantLimits[tenantId];  // e.g., VIP { concurrency: 100 } vs normal { concurrency: 5 }
  return {
    'expensive': augmentModel(expensiveBase, [
      withLimit({ store: tenantStore, rules: [{ type: 'concurrency', key: tenantId, limit: limits.concurrency }] }),
    ]),
    'cheap': augmentModel(cheapBase, [
      withLimit({ store: tenantStore, rules: [{ type: 'concurrency', key: `${tenantId}:cheap`, limit: limits.concurrency * 2 }] }),
    ]),
  };
}
await runWith(async () => await MyAgent(props), { modelRegistry: getModelRegistry(req.tenantId) });
```

## Error Types

| Error | code | When thrown | Key fields |
|-------|------|-------------|------------|
| `RateLimitExceededError` | `429` | Store determines limit exceeded (concurrency / RPM / TPM) | `retryAfterMs` (maps directly to HTTP `Retry-After`), `reason` (limit dimension), `failedRule` (the rule that caused the limit) |
| `TokenLimitExceededError` | `413` | Estimated tokens exceed a token rule's **absolute limit** — waiting won't help | `estimatedTokens`, `limit`; client must shorten input, not retry |

Both are exported from `@rejelly/limit-model`. Note the distinction: 429 means "retry later", 413 means "will never succeed" — do not confuse them when mapping to HTTP status codes.
