# Limit Model (限流)

`@rejelly/limit-model` 提供模型限流中间件,通过 [`augmentModel`](/zh/api/core#augmentmodel-model-middlewares) 挂到任意 `ModelAdapter` 上:

- **`withSimpleLimit(options)`**:rpm / tpm / concurrency 简化封装,快速接入。
- **`withLimit(options)`**:Rule 级,每条规则自带 key,支持多维度组合与可插拔 Store。

限流采用**快速失败**策略:超限直接抛错([错误类型](#错误类型)),不排队、不发「限流等待」类事件。

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
    store: undefined,  // 不传则为本次中间件创建新的 MemoryStore
  }),
]);
```

**配置项(SimpleLimitOptions):**

| 属性 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `rpm` | `number` | ❌ | - | 每分钟最大请求数 |
| `tpm` | `number` | ❌ | - | 每分钟最大 Token 数 |
| `concurrency` | `number` | ❌ | - | 最大并发数 |
| `key` | `string` | ❌ | `"default-model"` | 限流作用域唯一标识，避免多模型规则互相覆盖 |
| `store` | `RateLimitStore` | ❌ | 新建独立 MemoryStore | 自定义存储（如 RedisStore）；不传则每个中间件实例各建一个内存 Store |

至少需要提供 `rpm`、`tpm`、`concurrency` 中的一项。内部会映射为对应的 Rule（key 形如 `${key}:rpm`）再走 `withLimit`。

## `withLimit(options)`

Rule 级限流：每条规则自带 `key`，同一请求可同时受多条规则约束（如租户全局并发 + 单模型 RPM）。

```typescript
import { augmentModel } from '@rejelly/core';
import { withLimit, MemoryStore, RedisStore } from '@rejelly/limit-model';

const store = new MemoryStore();  // 或 new RedisStore(redisClient)
const ruleLimitedModel = augmentModel(baseModel, [
  withLimit({
    store,
    rules: [
      // 总级别 gpt4
      { type: 'concurrency', key: 'gpt4', limit: 100 },
      { type: 'request', key: 'gpt4', limit: 500, windowMs: 60000 },
      { type: 'token', key: 'gpt4', limit: 500000, windowMs: 60000 },
      // 租户 A 维度
      { type: 'concurrency', key: 'tenant:A', limit: 10 },
      { type: 'request', key: 'tenant:A:gpt4', limit: 50, windowMs: 60000 },
      { type: 'token', key: 'tenant:A:gpt4', limit: 90000, windowMs: 60000 },
    ],
  }),
]);
```

**配置项(WithLimitOptions):**

| 属性 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `store` | `RateLimitStore` | ✅ | - | 注入的存储（MemoryStore / RedisStore / 自实现） |
| `rules` | `RateLimitRule[]` | ✅ | - | 限流规则数组，按数组顺序检查、第一条超限即失败 |
| `calculatePreDeduct` | `(messages) => number` | ❌ | 输入文本长度 / 4 | Token 预扣估算：请求前按估算预扣，流结束后按实际 usage 多退少补 |
| `retryAfterBufferMs` | `number` | ❌ | `100` | 在 store 返回的 `retryAfterMs` 上追加的缓冲，避免严格按时重试的客户端再次撞限 |

**Rule 类型:**

| 类型 | 说明 | 字段 |
|------|------|------|
| `ConcurrencyRule` | 并发数 | `type: 'concurrency'`, `key`, `limit`（无 windowMs） |
| `RequestRule` | 每分钟请求数 (RPM) | `type: 'request'`, `key`, `limit`, `windowMs` |
| `TokenRule` | 每分钟 Token 数 (TPM) | `type: 'token'`, `key`, `limit`, `windowMs` |

## Store

- **MemoryStore**：单机内存，适合开发或**单进程**部署。
- **RedisStore**：生产用，需传入满足 `RedisLike` 的客户端（如 ioredis）。并发用 ZSET（member=requestId, score=过期时间），进程被 kill 后由 Lua 内 `ZREMRANGEBYSCORE` 自愈；Token/Request 用 Hash 桶。Key 格式为 `{hashTag}:key:type`，**hash tag** 决定 Redis Cluster slot：默认固定为 `limit-model`，所有 key 同槽，任意规则组合都能在一个 Lua 脚本内原子检查。

> **⚠️ MemoryStore 不适用于多进程**
>
> MemoryStore 的数据在**进程内内存**，不跨进程共享。在 **PM2 多进程 / cluster 模式、多实例部署、Serverless 多实例**等场景下，每个进程各自计数，限流额度会被成倍放大（例如 4 个 worker 则等效 4 倍并发），限流失效。此类部署必须使用 **RedisStore**（或其它跨进程共享的 Store）。
>
> **⚠️ RedisStore 存在单点瓶颈**
>
> **限流实现说明**：RedisStore 内部依赖 Redis Lua 脚本 + 同槽 key 实现一致性。默认固定 hash tag 时，**所有**限流流量集中在单个节点（Lua 单线程执行，等效单核），请勿在极高 QPS 场景下（通常是 QPS>1W）使用。多租户场景可通过 `hashTag` 函数按租户分 slot 分散热点（见下方配置项与示例），代价是同一次检查内不能混用跨租户的全局规则。

**RedisStore 配置项（RedisStoreOptions）：**

| 属性 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `maxConcurrencyTimeoutMs` | `number` | ❌ | `60000` | 并发槽最长持有时间；超时由 Lua 内清理回收（防进程被 kill 后死锁） |
| `prefix` | `string` | ❌ | - | key 前缀（不参与 hash tag，不影响 slot） |
| `hashTag` | `string \| (rule) => string` | ❌ | `"limit-model"` | Redis Cluster hash tag。string：整个 store 一个 tag（如隔离多套部署）；函数：按 rule 逐条计算 tag（建议只从 `rule.key` 派生，如取租户段），把不同租户散到不同 slot。**同一次限流检查内的所有 rule 必须算出相同 tag**，混用会在发往 Redis 前直接抛错 |

```typescript
// 多租户分散热点：按 rule.key 的租户段分 hash tag（split 规则需与你的 key 命名约定一致）
const store = new RedisStore(redisClient, {
  hashTag: (rule) => rule.key.split(':')[0],
});
// 同一次检查、同一租户的两条 rule —— tag 相同，同槽，原子 ✓
//   { type: 'concurrency', key: 'tenantA' }    → {tenantA}:tenantA:concurrency
//   { type: 'request', key: 'tenantA:gpt-4' }  → {tenantA}:tenantA:gpt-4:request
// tenantB 的检查落在另一个 slot —— 热点被分散
//   { type: 'token', key: 'tenantB:gpt-4' }    → {tenantB}:tenantB:gpt-4:token
```

按租户分 tag 后，原子性单元从「整个 store」收缩为「tag 相同的 rule 集合」：同一次检查内不能再混用跨租户的全局规则（如全局 `gpt4` 并发 + 租户规则），要么放弃全局规则，要么拆成两次检查并接受不再原子。

## 多租户完整示例

按 tenantId 组 `modelRegistry`，`withLimit` 的 key 用租户 id，配额从 tenantLimits 读；store 用 RedisStore + 按租户分 hash tag，各租户的限流 key 散到不同 Redis Cluster slot。

```typescript
import { augmentModel, runWith, type ModelAdapter } from '@rejelly/core';
import { withLimit, RedisStore } from '@rejelly/limit-model';

// ⚠️ split 规则必须与 key 命名约定一致：本例 key 以租户 id 开头（`tenantId`、`${tenantId}:cheap`），取首段即租户；
//    若照搬到上文 withLimit 示例那种 'tenant:A:gpt4' 命名，所有租户都会算出同一个 tag "tenant"，分槽失效。
//    分 tag 后同一条 withLimit 的 rules 也不能再混入跨租户的全局规则（如全局 'gpt4'），tag 不同会直接抛错。
const tenantStore = new RedisStore(redisClient, {
  hashTag: (rule) => rule.key.split(':')[0],
});

function getModelRegistry(tenantId: string): Record<string, ModelAdapter> {
  const expensiveBase = createOpenAIAdapter({ modelId: 'gpt-5.6-sol' });
  const cheapBase = createOpenAIAdapter({ modelId: 'gpt-5.6-luna' });
  const limits = tenantLimits[tenantId];  // 例如 VIP { concurrency: 100 } vs 普通 { concurrency: 5 }
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

## 错误类型

| 错误 | code | 何时抛出 | 关键字段 |
|------|------|----------|----------|
| `RateLimitExceededError` | `429` | store 判定超限（并发 / RPM / TPM） | `retryAfterMs`（可直接映射 HTTP `Retry-After`）、`reason`（超限维度）、`failedRule`（导致超限的那条规则） |
| `TokenLimitExceededError` | `413` | 预估 token 超过某条 token 规则的**绝对上限**——请求再等也不可能通过 | `estimatedTokens`、`limit`；客户端必须缩短输入，而不是重试 |

两者均从 `@rejelly/limit-model` 导出。注意区分:429 是「稍后重试」,413 是「永远不会成功」,对外映射 HTTP 状态码时不要混为一谈。
