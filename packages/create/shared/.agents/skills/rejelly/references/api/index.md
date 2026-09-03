# Rejelly API Documentation

> For design philosophy see [Guide · Introduction](/en/guide/); this page is an API map organized by **lifecycle phase**.

## API Document Structure

Rejelly's API is organized by **lifecycle phase**, following a clear execution flow:

### 1. [Core](/en/api/core)
- `createAgent` - Define an Agent
- `promptAgent` - Call the LLM
- `ModelAdapter` - Model adapter interface
- `dumpSnapshot` / `restoreSnapshot` / `runWith` - Snapshot and restore
- `augmentModel` / `augmentTool` / `augmentAgent` - Augmentation mechanism (model / tool / Agent)
- `callTool` - Manually invoke a single tool (bypassing the model tool-call loop)

### 2. [Equip (Input & Context)](/en/api/equip)
- `equipSystem` / `equipInstruction` - Prompt building
- `equipMemory` / `equipMemo` - Agent memory (within a single invocation, across `reborn`, destroyed on Agent return)
- `equipResource` - Resource management
- `equipTool` - Tool registration
- `equipBudget` / `equipScope` - Budget and scope
- `equipTraceAttr` - Add attributes to traces
- [Budget](/en/api/budget) - Budget control and usage statistics

### 3. [Adapter](/en/api/adapter/)
- [Model Adapter](/en/api/adapter/model) - OpenAI / Gemini model adaptation, `schemaMode` and provider configuration
- [MCP](/en/api/adapter/mcp) - `equipMCP` / `MCPKit` / resource tools / parent-child Agent exposure
- [LangChain](/en/api/adapter/langchain) - `fromLangChainTool`
- [Limit Model](/en/api/limit-model) - `withLimit` / `withSimpleLimit` model rate-limiting middleware, MemoryStore / RedisStore
- [Multimodal tool results](/en/api/adapter/#multimodal-tool-results) - Shared contract between model adapter send-side and tool adapter receive-side

### 4. [Expect (Output & Validation)](/en/api/expect)
- `expectValidator` - Custom validation
- `expectScope` / `expectResource` - Dependency declaration

### 5. [Effect (Side Effects)](/en/api/effect)
- `onStream` - Agent-level streaming event listener

### 6. [Flow](/en/api/flow)
- `reborn` - Reload directive
- Calling sub-agents

### 7. [Policy](/en/api/policy)
- `createAgentPolicy` - Custom policy factory (prompt lifecycle, telemetry, Runtime Seal)
- `executeTurn` / `executeTools` / `executeValidation` - Execution primitives (internal to policies)
- `executeValidatedLoopTurn` / `transferJsonSchema` - Preset loop combinators
- All imported from the independent sub-path `@rejelly/core/policy`

### 8. [Testing](/en/api/testing)
- `createMockModel` - Create a Mock Model
- Mock Model API - Rule configuration, call records

### 9. [Debug](/en/api/debug)
- Console Logger - Console logging
- File Logger - File logging
- OTLP Exporter - Distributed tracing
- Review Exporter - Real-time trace visualization
- `withCustomSpan` - Manual trace spans

---

## Quick Start

```typescript
import { createAgent, equipSystem, equipInstruction, promptAgent } from '@rejelly/core';
import { z } from 'zod';

const MyAgent = createAgent({
  id: 'my_agent',
  handler: async (props) => {
    equipSystem('You are an assistant');
    equipInstruction(`Task: ${props.task}`);
    
    const ResultSchema = z.object({ answer: z.string() });
    return await promptAgent(ResultSchema);
  }
});

const result = await MyAgent({ task: 'Answer a question' });
```

---

## Core Mechanisms

### Validation Retry (Self-Correction)

When Schema validation of `promptAgent(schema)` or `expectValidator` validation fails, the framework automatically performs Self-Correction retries:

```
LLM output → Validate → Fail → Append error hint to prompt → Re-call LLM → Validate → ...
                         ↓
                    Retries exhausted
                         ↓
               Throws AttemptsExhaustedError
```

### Reborn: Rebuild Context Across Rounds

When an Agent needs to proceed to the next reasoning round, the recommended approach is `return reborn()` to end the current Generation and re-run the handler. This way `equipSystem` / `equipInstruction` / `equipTool` and other draft components are freshly collected from the latest state, and the Prompt is naturally refreshed.

If you manually write a loop inside a single handler execution and repeatedly process historical messages, you risk falling back to an append-only conversation pattern: the context grows longer, and the Prompt building logic becomes scattered across loop branches.

`reborn()` returns an object marked with a special Symbol (`RebornSignal`). The framework checks the return value via `isRebornSignal()` to decide whether to re-run.

## Call Order Constraints

**Functions that must be called before `promptAgent()`:**

- `equipSystem()` - Must be called before promptAgent
- `equipInstruction()` - Must be called before promptAgent
- `equipTool()` - Must be called before promptAgent
- `equipBudget()` - Must be called before promptAgent
- `expectValidator()` - Must be called before promptAgent
- `onStream()` - Must be called before promptAgent

**Functions that do NOT need to be called before `promptAgent()`:**

- `equipScope()` - Must be called before invoking a sub-agent (unrelated to promptAgent)
- `equipTraceAttr()` - Can be called anywhere in the handler to tag the current agent/generation span (exposed in trace.attributes of agent:end, generation:end)
- `expectScope()` - Can be called anywhere (used to read parent Agent's scope)
- `expectResource()` - Can be called anywhere (used to read parent Agent's exposed resources)
- `equipMemory()` / `equipMemo()` - Can be called anywhere (Agent memory: within a single invocation, across reborn, destroyed on Agent return)

**Rationale**:
- **promptAgent-related**: The framework collects all configured equip/expect calls when `promptAgent()` is invoked, building the complete Prompt and sending it to the LLM. Functions called after `promptAgent()` have no effect.
- **Sub-agent related**: `equipScope()` provides scope for sub-agents and must be called before invoking a sub-agent — unrelated to `promptAgent()`.
- **Reading dependencies**: `expectScope()` and `expectResource()` read scope and resources provided by the parent Agent and can be called anywhere (including after promptAgent). Cross-agent / cross-session persistent state is injected via `runWith({ providers })` using real database, Redis, or SDK clients, then read via `expectResource()`.
