# @rejelly/limit-model

Rate limiting middleware for model adapters: token (TPM), request (RPM), and concurrency limits, with pluggable stores (in-memory / Redis). Fast-fail semantics — over-limit calls throw immediately instead of queueing.

## Install

```sh
npm install @rejelly/limit-model
```

## Quick start

```ts
import { augmentModel } from '@rejelly/core';
import { withSimpleLimit } from '@rejelly/limit-model';

const limitedModel = augmentModel(baseModel, [
  withSimpleLimit({ rpm: 60, tpm: 90000, concurrency: 5, key: 'my-model' }),
]);
```

Provide at least one of `rpm` / `tpm` / `concurrency`. Without a `store`, each middleware gets its own in-memory store — single process only.

## Rule-level limits

`withLimit` takes explicit rules, each with its own key, so one request can be bounded by multiple dimensions (e.g. tenant-global concurrency + per-model RPM):

```ts
import { withLimit, RedisStore } from '@rejelly/limit-model';

const store = new RedisStore(redisClient); // any client satisfying RedisLike, e.g. ioredis

const limitedModel = augmentModel(baseModel, [
  withLimit({
    store,
    rules: [
      { type: 'concurrency', key: 'tenant:A', limit: 10 },
      { type: 'request', key: 'tenant:A:gpt4', limit: 50, windowMs: 60000 },
      { type: 'token', key: 'tenant:A:gpt4', limit: 90000, windowMs: 60000 },
    ],
  }),
]);
```

## Stores

- **MemoryStore** — single process; development or single-instance deployments.
- **RedisStore** — production; all rules of one check run in a single Lua script (atomic check-then-commit). Concurrency slots self-heal when a process dies. By default every key shares one Redis Cluster hash tag (`{limit-model}`), so any rule combination is atomic but all traffic lands on one node. For multi-tenant deployments, pass `hashTag: (rule) => …` to spread tenants across slots — all rules within one check must then map to the same tag.

Using MemoryStore behind PM2 / cluster / multiple instances multiplies your effective limits per process — use RedisStore there.

## Errors

- `RateLimitExceededError` (`code: 429`) — over limit; carries `retryAfterMs`, `reason`, and the `failedRule`.
- `TokenLimitExceededError` (`code: 413`) — the estimated tokens exceed a token rule's absolute limit; retrying can never succeed, the input must be shortened.

## License

Apache-2.0
