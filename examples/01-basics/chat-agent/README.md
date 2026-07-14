# Chatty Agent (Multi-turn Chat Customer Service Example)

> [中文](README.zh-CN.md) | English

This example shows how to build a **multi-turn conversation system** with Rejelly.

Unlike the traditional `while(true)` outer loop, this example keeps the conversation flow and state management entirely inside the Agent, using `reborn` and `equipMemory` to implement a clear state-machine style dialogue loop.

## Core mechanisms

1. **In-agent suspension / waiting for input**: Inside the `handler`, execution is suspended with `await userInput()` until real external input (terminal, WebSocket, or API) is provided.
2. **Cross-turn memory**: Use `equipMemory` to declare and persist conversation history (`conversation_history`). State is restored automatically after `reborn`, with no need to maintain global variables outside.
3. **Goal-based loop (Reborn)**: No `while` loop. After finishing one turn and updating Memory, the Agent is restarted with `return reborn()`. Each run builds the cleanest Prompt from the latest Memory, avoiding context pollution.

## Paradigm comparison

### Traditional: outer loop + manual history stacking

```typescript
let history = [];

// External control flow, logic split, Prompt grows with each iteration
while (true) {
  const input = await getUserInput();
  history.push({ role: 'user', content: input });
  
  const prompt = `History: ${history.join('\n')}`;
  const response = await callLLM(prompt);
  history.push({ role: 'assistant', content: response });
  
  if (isSatisfied) break;
}

```

### Rejelly: in-agent state machine + Reborn

```typescript
handler: async () => {
  // 1. Declare memory (persists across reborn)
  const [history, setHistory] = equipMemory('history', []);
  
  // 2. Wait for external input
  const userMessage = await userInput();
  
  // 3. Pass history + latest input as real chat Messages
  const { data: decision } = await promptChat({
    message: [...history, { role: 'user', content: userMessage }],
    schema: ResponseSchema,
  });
  
  // 4. Update memory
  setHistory([...history, userMessage, decision.response]);
  
  // 5. State transition: end or restart
  if (decision.isSatisfied && !decision.shouldContinue) {
    return decision; // end conversation
  }
  
  return reborn(); // restart handler with new state (next turn)
}

```

## Directory structure

```text
chatty-customer-service/
├── types.ts                  # Interfaces and types
├── chatty-agent.ts           # Chatty Agent core logic
├── index.ts                  # Entry and mock data
└── README.md                 # Documentation

```

## Run the example

From the `examples` directory, run the script and select this example (**Chat Agent**) in the interactive menu:

```bash
cd examples
pnpm start
```
