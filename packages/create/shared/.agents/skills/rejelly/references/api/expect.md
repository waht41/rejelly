# Expect (Output & Validation)

This phase centers on the **`expect*` API**: custom validation (`expectValidator`) and reading parent-provided dependencies (`expectScope` / `expectResource`).

## Schema Validation

Schema is directly defined and validated by `promptAgent(schema)`:

```typescript
const result = await promptAgent(
  z.object({
    action: z.enum(['search', 'answer']),
    content: z.string(),
  })
)
```

## Custom Validation

### `expectValidator(validator)` / `expectValidator(schema, validator)`

**validator**: `(data) => boolean | string | Promise<boolean | string>`
- Returns `true`: validation passes
- Returns `string`: validation fails, the error message is appended to the prompt for retry
- Returns `false`: validation fails, uses the default error message `"Validation failed"` (returning a descriptive string is recommended)

An optional first parameter `schema` (Zod Schema) is used solely for inferring `data`'s type, not for runtime validation (runtime Schema validation is handled by `promptAgent(schema)`).

**Retries**: Controlled by `createAgent`'s `maxRetries` config (default 3).

**Exhausted attempts**: Throws `AttemptsExhaustedError` (message contains "All attempts exhausted"), with `attempts` / `issues` / `lastFailureType` / `lastData` / `lastRawText` on the instance. There is no validator-level callback; fallback logic should be implemented at the Agent call site.

```typescript
import { AttemptsExhaustedError, expectValidator } from '@rejelly/core';
import { QuoteSchema } from './schemas';

// Basic usage: returning a string triggers retry; schema is only for type inference
expectValidator(QuoteSchema, (data) => {
  if (data.price < 0) return "Price cannot be negative, please correct";
  if (data.price > 10000 && !data.isVip) return "Non-VIP users cannot exceed 10000 per item";
  return true;
});

// Exhausted attempts: catch at the Agent call site, throw a custom error or return a fallback value
try {
  return await QuoteAgent({ sku });
} catch (err) {
  if (err instanceof AttemptsExhaustedError) {
    console.warn(`Failed to generate valid price: ${err.issues.join(', ')}`);
    return { price: 0, status: 'error' }; // fallback value
  }
  throw err;
}
```

## Persistent State

Core no longer provides a dedicated KV facade. Cross-agent, cross-session, or cross-process persistent state should be injected via `runWith({ providers })` with real clients and read via `expectResource()`.

```typescript
import { expectResource, runWith } from '@rejelly/core';

await runWith(async () => {
  const redis = expectResource<RedisClient>('redis');
  await redis.incr(`quota:${userId}`); // Use the client's native atomic capabilities
}, {
  providers: {
    redis,
  },
});
```

Principles:

- Keys should be explicitly constructed by business logic, e.g., `user:${userId}:cart` — do not derive persistent keys from the call tree position.
- Consistency-sensitive state (billing, inventory, quotas, cross-key invariants) should use your own database transactions, Redis atomic operations, CAS/OCC, or queue/single-writer models.
- For call-level observability, wrap injected clients with `instrument(client, { name, ops, derive })`.

## Dependency Declaration

### `expectScope(schema)`

Declares and reads scope data provided by the parent Agent. Validates with a Zod Schema for type safety. **Fast-fail**: throws `ScopeError` immediately on validation failure, no tokens consumed. **Return value**: Deep Readonly object (recursively frozen via `Object.freeze`).

```typescript
import { expectScope } from '@rejelly/core';
import { z } from 'zod';

// Child Agent declares dependency
handler: async () => {
  const ctx = expectScope(z.object({
    userId: z.string(),
  }));

  // TypeScript knows ctx.userId is string
  console.log(ctx.userId);

  // ctx.userId = 'xxx'; // ❌ Runtime error (Object.freeze)
}

// Optional fields with default values
const ctx = expectScope(z.object({
  debug: z.boolean().default(false),
  retries: z.number().default(3)
}));

// Fast-fail — no tokens consumed
const ctx = expectScope(z.object({
  requiredApiKey: z.string() // If not provided, throws ScopeError immediately
}));
```

**equipScope/expectScope usage example:**

```typescript
// Parent Agent: provides scope
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

// Child Agent: declares and reads scope
const ChildAgent = createAgent({
  id: 'child',
  handler: async (props) => {
    // Declare required scope fields
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

**Scope hierarchy and shadowing:**

```typescript
// Grandparent Agent
equipScope({ theme: 'dark', lang: 'en' });

// Parent Agent
equipScope({ lang: 'zh' }); // Shadows grandparent's lang

// Child Agent
const scope = expectScope(z.object({
  theme: z.string(),  // 'dark' (from grandparent)
  lang: z.string()    // 'zh' (from parent, shadowing grandparent's 'en')
}));
```

### `expectResource<T>(key, options?)`

Declares and retrieves a resource exposed by the parent Agent. Searches up the Context chain recursively, returning the first match (nearest parent first). **Fast-fail**: throws `ResourceNotFoundError` immediately if the resource is not found — no tokens consumed. Supports TypeScript generics for type inference.

**options.optional**: Passing the literal `{ optional: true }` makes the resource optional — returns `undefined` instead of throwing when not found, with the return type becoming `T | undefined`. TypeScript forces null-checking before use. Note the overload only accepts the literal `true`: `{ optional: false }` or a boolean variable will not match any overload (compile error) — a resource is either explicitly optional or required.

```typescript
import { expectResource } from '@rejelly/core';

// Child Agent declares a resource dependency (required: throws ResourceNotFoundError if not found)
handler: async () => {
  // Get the database connection exposed by the parent Agent
  const db = expectResource<Database>('database');
  
  // TypeScript knows db is of type Database
  const users = await db.query('SELECT * FROM users');
  return { users };
}

// Optional resource: { optional: true } returns T | undefined, no throw on miss
handler: async () => {
  const cache = expectResource<Cache>('cache', { optional: true });
  if (cache) {
    return await cache.get('key');
  }
  return null; // Degraded path when no cache available
}
```

**equipResource/expectResource usage example:**

```typescript
// Parent Agent: creates and exposes a resource
const ParentAgent = createAgent({
  id: 'parent',
  handler: async () => {
    // Create and expose a database connection
    const db = await equipResource('database', {
      create: async () => await connectDB(),
      destroy: async (conn) => await conn.close(),
      deps: [],
      expose: true  // Key: expose to child Agents
    });

    // Pass data context
    equipScope({ tenantId: '1001' });
    
    return await ChildAgent({ task: 'analyze' });
  }
});

// Child Agent: declares and reads resource dependency
const ChildAgent = createAgent({
  id: 'child',
  handler: async () => {
    // Get data dependency
    const { tenantId } = expectScope(z.object({ tenantId: z.string() }));
    
    // Get resource dependency (Runtime Object)
    const db = expectResource<Database>('database');
    
    // Use the resource directly
    return await db.query('SELECT * FROM users WHERE tenant_id = ?', [tenantId]);
  }
});
```

**Resource lookup rules:**

- Starts from the current Context and traverses up the parent Context chain
- Searches for the specified key in each Context's `providers` Map
- Returns the first resource found (nearest parent first)
- If the entire Context chain yields no match, throws `ResourceNotFoundError` (returns `undefined` when `{ optional: true }`)

**Notes:**

- The resource key must exactly match the key used in `equipResource`
- The parent Agent must set `expose: true` for the resource to be accessible to child Agents
- Resource lookup is synchronous — no `await` needed
- Supports TypeScript generics for type safety
- When multiple parents expose the same resource key, the nearest parent's resource is used (nearest parent first)

MCP: After the parent Agent exposes an official Client via `equipResource('mcp:…', { expose: true })`, the child Agent uses **`expectResource<MCPClientAdapter>('mcp:…')`** to retrieve the same instance (type from `@rejelly/adapter-mcp`). For combination with `equipMCP`, see [Adapter · MCP](/en/api/adapter/mcp).
