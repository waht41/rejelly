# Expect (输出与验证)

这一阶段以 **`expect*` API** 为主：包含自定义验证（`expectValidator`）以及读取父级提供的依赖（`expectScope` / `expectResource`）。

## Schema 验证

Schema 由 `promptAgent(schema)` 直接定义与校验：

```typescript
const result = await promptAgent(
  z.object({
    action: z.enum(['search', 'answer']),
    content: z.string(),
  })
)
```

## 自定义验证

### `expectValidator(validator)` / `expectValidator(schema, validator)`

**validator**: `(data) => boolean | string | Promise<boolean | string>`
- 返回 `true`: 验证通过
- 返回 `string`: 验证失败，错误信息会拼接到 prompt 重试
- 返回 `false`: 验证失败，使用默认错误信息 `"Validation failed"`（建议返回 string 说明原因）

可选的第一个参数 `schema`（Zod Schema）仅用于推断 `data` 的类型，不参与运行时校验（运行时 Schema 校验由 `promptAgent(schema)` 承担）。

**重试次数**：由 `createAgent` 的 `maxRetries` 配置（默认 3）。

**尝试耗尽**：抛出 `AttemptsExhaustedError`（message 含 "All attempts exhausted"），实例上带 `attempts` / `issues` / `lastFailureType` / `lastData` / `lastRawText`。没有 validator 级别的回调；兜底逻辑在 Agent 调用处捕获实现。

```typescript
import { AttemptsExhaustedError, expectValidator } from '@rejelly/core';
import { QuoteSchema } from './schemas';

// 基本用法：返回 string 会重试；schema 仅用于推断 data 类型
expectValidator(QuoteSchema, (data) => {
  if (data.price < 0) return "价格不能为负数，请修正";
  if (data.price > 10000 && !data.isVip) return "非 VIP 用户单价不能超过 10000";
  return true;
});

// 尝试耗尽：在 Agent 调用处捕获，抛自定义错误或返回兜底值
try {
  return await QuoteAgent({ sku });
} catch (err) {
  if (err instanceof AttemptsExhaustedError) {
    console.warn(`无法生成有效价格: ${err.issues.join(', ')}`);
    return { price: 0, status: 'error' }; // 兜底值
  }
  throw err;
}
```

## 持久化状态

Core 不再提供专用 KV facade。跨 Agent、跨 Session 或跨进程的持久状态应通过 `runWith({ providers })` 注入真实客户端，并用 `expectResource()` 读取。

```typescript
import { expectResource, runWith } from '@rejelly/core';

await runWith(async () => {
  const redis = expectResource<RedisClient>('redis');
  await redis.incr(`quota:${userId}`); // 使用客户端原生原子能力
}, {
  providers: {
    redis,
  },
});
```

原则：

- key 由业务显式构造，例如 `user:${userId}:cart`，不要依赖调用树位置派生持久 key。
- 计费、库存、配额、跨 key 不变量等一致性敏感状态应使用用户自己的数据库事务、Redis 原子操作、CAS/OCC 或队列/单写者模型。
- 需要调用级观测时，用 `instrument(client, { name, ops, derive })` 包装注入的客户端。

## 依赖声明

### `expectScope(schema)`

声明并读取父 Agent 提供的作用域数据。使用 Zod Schema 进行验证，类型安全。**快速失败**：验证失败时立即抛出 `ScopeError`，不消耗 Token。**返回值**：Deep Readonly 对象（通过 `Object.freeze` 递归冻结）。

```typescript
import { expectScope } from '@rejelly/core';
import { z } from 'zod';

// 子 Agent 声明依赖
handler: async () => {
  const ctx = expectScope(z.object({
    userId: z.string(),
  }));

  // TypeScript 知道 ctx.userId 是 string
  console.log(ctx.userId);

  // ctx.userId = 'xxx'; // ❌ 运行时错误（Object.freeze）
}

// 可选字段带默认值
const ctx = expectScope(z.object({
  debug: z.boolean().default(false),
  retries: z.number().default(3)
}));

// 快速失败 - 不消耗 Token
const ctx = expectScope(z.object({
  requiredApiKey: z.string() // 如果未提供，立即抛出 ScopeError
}));
```

**equipScope/expectScope 配合使用示例：**

```typescript
// 父 Agent：提供作用域
const ParentAgent = createAgent({
  id: 'parent',
  handler: async () => {
    equipScope({
      userId: 'u_123',
      permissions: ['read', 'write'],
      config: { timeout: 5000 }
    });
    
    return await ChildAgent({ task: 'analyze' });
  }
});

// 子 Agent：声明并读取作用域
const ChildAgent = createAgent({
  id: 'child',
  handler: async (props) => {
    // 声明依赖的作用域字段
    const scope = expectScope(z.object({
      userId: z.string(),
      permissions: z.array(z.string()),
      config: z.object({
        timeout: z.number().default(3000)
      })
    }));
    
    equipInstruction(`User ${scope.userId} with permissions: ${scope.permissions.join(', ')}`);
    
    return await promptAgent(ResultSchema);
  }
});
```

**作用域层级与遮蔽：**

```typescript
// 祖父 Agent
equipScope({ theme: 'dark', lang: 'en' });

// 父 Agent
equipScope({ lang: 'zh' }); // 遮蔽祖父的 lang

// 子 Agent
const scope = expectScope(z.object({
  theme: z.string(),  // 'dark' (来自祖父)
  lang: z.string()    // 'zh' (来自父，遮蔽了祖父的 'en')
}));
```

### `expectResource<T>(key, options?)`

声明并获取父级 Agent 暴露的资源。沿 Context 链向上递归查找，返回第一个匹配的资源（最近父级优先）。**快速失败**：资源未找到时立即抛出 `ResourceNotFoundError`，不消耗 Token。支持 TypeScript 泛型类型推断。

**options.optional**：传字面量 `{ optional: true }` 时资源改为可选——未找到返回 `undefined` 而不抛错，返回类型相应变为 `T | undefined`，TS 会强制判空后再使用。不传 options 时返回类型就是 `T`，无需 guard。注意重载只接受字面量 `true`：`{ optional: false }` 或 boolean 变量不匹配任何重载（编译报错）——资源要么明确可选，要么必须。

```typescript
import { expectResource } from '@rejelly/core';

// 子 Agent 声明资源依赖（必须资源：未找到抛 ResourceNotFoundError）
handler: async () => {
  // 获取父 Agent 暴露的数据库连接
  const db = expectResource<Database>('database');
  
  // TypeScript 知道 db 是 Database 类型
  const users = await db.query('SELECT * FROM users');
  return { users };
}

// 可选资源：{ optional: true } 返回 T | undefined，未找到不抛错
handler: async () => {
  const cache = expectResource<Cache>('cache', { optional: true });
  if (cache) {
    return await cache.get('key');
  }
  return null; // 无缓存时的降级路径
}
```

**equipResource/expectResource 配合使用示例：**

```typescript
// 父 Agent：创建并暴露资源
const ParentAgent = createAgent({
  id: 'parent',
  handler: async () => {
    // 创建并暴露数据库连接
    const db = await equipResource('database', {
      create: async () => await connectDB(),
      destroy: async (conn) => await conn.close(),
      deps: [],
      expose: true  // 关键：暴露给子 Agent
    });

    // 传递数据环境
    equipScope({ tenantId: '1001' });
    
    return await ChildAgent({ task: 'analyze' });
  }
});

// 子 Agent：声明并读取资源依赖
const ChildAgent = createAgent({
  id: 'child',
  handler: async () => {
    // 获取数据依赖
    const { tenantId } = expectScope(z.object({ tenantId: z.string() }));
    
    // 获取资源依赖（Runtime Object）
    const db = expectResource<Database>('database');
    
    // 直接使用资源
    return await db.query('SELECT * FROM users WHERE tenant_id = ?', [tenantId]);
  }
});
```

**资源查找规则：**

- 从当前 Context 开始，向上遍历父级 Context 链
- 在每个 Context 的 `providers` Map 中查找指定 key
- 返回第一个找到的资源（最近父级优先）
- 如果整个 Context 链都未找到，抛出 `ResourceNotFoundError`（`{ optional: true }` 时改为返回 `undefined`）

**注意事项：**

- 资源 key 必须与 `equipResource` 中使用的 key 完全匹配
- 父 Agent 必须设置 `expose: true` 才能被子 Agent 访问
- 资源查找是同步的，不需要 `await`
- 支持 TypeScript 泛型，提供类型安全
- 多个父级都暴露同名资源时，使用最近的父级资源（最近父级优先）

MCP：父 Agent 用 `equipResource('mcp:…', { expose: true })` 暴露官方 Client 后，子 Agent 用 **`expectResource<MCPClientAdapter>('mcp:…')`** 取同一实例（类型见 `@rejelly/adapter-mcp`）。与 `equipMCP` 的组合见 [Adapter · MCP](/zh/api/adapter/mcp)。
