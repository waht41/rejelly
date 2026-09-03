# Flow

These are return values or interrupt operations of the async handler.

## Calling Sub-Agents

Call a sub-agent function directly and await its result. _Parent-child relationship:_ Stack-based invocation.

```typescript
// Directly call a sub-agent
const result = await ChildAgent({ query: 'hello' });

// Call a sub-agent within a parent Agent
handler: async (props) => {
  equipSystem('You are a coordinator');
  
  // Call a search Agent
  const searchResult = await SearchAgent({ query: props.query });
  
  // Call an analysis Agent
  const analysis = await AnalyzeAgent({ data: searchResult });
  
  return { searchResult, analysis };
}
```

## `reborn(newProps?)`

**Reload directive.** Immediately ends the current function execution, **preserves the current `equipMemory` state**, and re-runs `handler`. You may pass new `newProps`; if omitted, the old props are reused.

**Note:** Memory updates should be done via `equipMemory`'s `setState` function before calling `reborn()`, not through the `reborn` parameter.

```typescript
// Update memory then reborn
const [attempts, setAttempts] = equipMemory('attempts', 0);
setAttempts(attempts + 1);
return reborn(); // Uses current props

// Update props and reborn
return reborn({ topic: 'new topic', retry: true });

// Only update props, keep memory
return reborn({ attempt: props.attempt + 1 });
```

## `return result`

Ends the current Agent task and returns the result to the caller (parent Agent or user).
