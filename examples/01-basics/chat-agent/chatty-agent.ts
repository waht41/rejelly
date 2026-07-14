/**
 * Chatty Customer Service Agent
 *
 * Features:
 * - Talkative, likes to chat
 * - Remembers previous conversation content
 * - May repeat and emphasize some information
 * - Demonstrates equipMemory + reborn multi-turn conversation scenarios
 * - Handles user input within Agent
 *
 * Verification Points:
 * 1. Can equipMemory remember conversation history?
 * 2. Can reborn implement multi-turn conversations?
 * 3. Can conversation history be passed as chat Messages via promptChat?
 * 4. Use await userInput() within Agent to get user input
 */

import {
  createAgent,
  equipInstruction,
  equipMemory,
  equipSystem,
  type Message,
  onStream,
  promptChat,
  reborn,
} from "@rejelly/core";
import { getModel } from "@shared/runtime-model";
import { z } from "zod";
import type { ChattyAgentProps, ChattyAgentResult } from "./types";

const model = getModel();

/**
 * Mock user input function
 * In real scenarios, this should get user input from terminal, WebSocket, API, etc.
 */
async function userInput(): Promise<string> {
  // Simulate getting user input from external source
  // In actual implementation, this could be:
  // - Read from terminal: readline.question()
  // - Receive from WebSocket: ws.on('message')
  // - Get from API request: req.body.message
  // - Get from message queue: queue.consume()

  // For demonstration, return a mock user input
  // In actual use, should replace with real input retrieval logic
  return new Promise((resolve) => {
    // Simulate async user input retrieval
    setTimeout(() => {
      // Can get user input from global variables, event listeners, etc.
      // For demonstration, use a simple mock
      const mockInputs = [
        "Hello, I would like to learn about your products",
        "What is the price?",
        "Are there any discounts?",
        "Okay, I understand, thank you",
      ];

      // Get current input index from global variable (not needed in real scenarios)
      const currentIndex = (global as any).__chattyAgentInputIndex || 0;
      (global as any).__chattyAgentInputIndex = currentIndex + 1;

      if (currentIndex < mockInputs.length) {
        resolve(mockInputs[currentIndex]);
      } else {
        resolve("Goodbye"); // Default to end conversation
      }
    }, 100);
  });
}

// Customer service response Schema
// Field order matters: streaming fills fields top-to-bottom, and — more importantly —
// the model generates them in this order, so earlier fields condition later ones.
//
// `reasoning` is placed FIRST on purpose ("reasoning-first" structured output): the
// model thinks before it commits to a reply or to the isSatisfied/shouldContinue
// decisions, so the reasoning actually drives those fields instead of being a
// post-hoc justification written after the answer is already fixed. This is the
// manual equivalent of a thinking channel and is most valuable for non-reasoning
// models. For models with a native reasoning/thinking capability you can usually
// drop the `reasoning` field entirely — the model already reasons before answering.
const ResponseSchema = z.object({
  reasoning: z.string().describe("Reasoning for this reply (think before answering)"),
  response: z.string().describe("Agent reply: detailed, friendly, verbose"),
  isSatisfied: z.boolean().describe("Whether the user is satisfied and the conversation can end"),
  shouldContinue: z
    .boolean()
    .describe("Whether to continue the conversation (user may have more questions)"),
});

/**
 * Render a stored Message as readable transcript text.
 * Assistant turns are persisted as the raw schema JSON envelope, so pull out the
 * `response` field for display; fall back to the raw content for anything else.
 */
function renderMessageText(message: Message): string {
  const content = typeof message.content === "string" ? message.content : "";
  if (message.role === "assistant") {
    try {
      const parsed = JSON.parse(content) as { response?: unknown };
      if (typeof parsed.response === "string") return parsed.response;
    } catch {
      // Not JSON (e.g. plain text or tool round-trip) — fall through to raw content.
    }
  }
  return content;
}

export const ChattyAgent = createAgent<ChattyAgentProps, ChattyAgentResult>({
  id: "chatty_customer_service_agent",
  model,

  handler: async (_props) => {
    // ============ Equipment Phase ============

    // 1. System instruction - Define chatty customer service personality
    equipSystem(`You are a "chatty" customer service agent with the following characteristics:
- Talkative, enthusiastic, likes to chat with users
- Responses should be detailed, not brief
- Can appropriately repeat and emphasize important information
- Proactively cares about users, asks for more details
- If user says "thank you", "okay", "I understand", "goodbye", etc., can determine if user is satisfied
- If user has more questions, continue the conversation
- Remember previous conversation content, don't repeat questions already asked`);

    // 2. Get conversation memory (key: after each reborn, will get updated value here)
    // History is stored as raw chat Messages — see the append logic below for why we
    // persist promptChat's `delta` verbatim instead of a hand-rebuilt string.
    const [conversationHistory, setConversationHistory] = equipMemory<Message[]>(
      "conversation_history",
      [],
    );

    const [turnCount, setTurnCount] = equipMemory<number>("turn_count", 0);
    const [userSatisfied, setUserSatisfied] = equipMemory<boolean>("user_satisfied", false);

    // 3. Get user input within Agent
    const userMessage = await userInput();

    console.log(`\n👤 [User] ${userMessage}`);
    console.log("-".repeat(50));

    // 4. Static instruction - only fixed rules here (stable prefix improves prompt
    // cache hits); conversation history and the latest user utterance are passed
    // as chat Messages to promptChat below instead of being stuffed into the instruction.
    equipInstruction(`Please generate a detailed, friendly, and talkative response. Remember:
- If this is the first turn (no conversation history), greet warmly
- If we've chatted before, refer to conversation history, don't repeat questions already asked
- Response should be detailed, at least 3-5 sentences
- If user indicates satisfaction or no more questions (e.g., "thank you", "okay", "I understand", "goodbye"), can end conversation`);

    // ============ Execution Phase ============

    // 6. Listen to streaming output for real-time frontend display
    // structured_data events carry a partially completed object, fields will be
    // gradually completed in Schema order: reasoning -> response -> isSatisfied -> shouldContinue
    // (so `response` only starts streaming once `reasoning` is done — reasoning-first).

    // Track last output length per field for a true incremental "typewriter" effect.
    // We stream `reasoning` first, then `response`, mirroring the generation order so
    // the visible output matches reasoning-first instead of showing the answer before
    // the thinking. Each field is appended only with its newly-arrived characters.
    let lastReasoningLength = 0;
    let lastResponseLength = 0;

    // Incrementally write the newly-arrived tail of a streamed field.
    // Returns the updated length so the caller can track progress.
    const streamField = (text: string, lastLength: number, prefix: string): number => {
      if (lastLength === 0) process.stdout.write(prefix);
      if (text.length > lastLength) {
        process.stdout.write(text.slice(lastLength));
        return text.length;
      }
      return lastLength;
    };

    onStream(async (stream) => {
      for await (const event of stream) {
        if (event.type !== "structured_data" || !event.isValid) continue;

        // event.data gradually completes in Schema order, for example:
        // 1st time: { reasoning: 'User said thanks...' }
        // 2nd time: { reasoning: '...', response: 'Okay, I understand' }
        // 3rd time: { reasoning: '...', response: '...', isSatisfied: true }
        // 4th time: { reasoning: '...', response: '...', isSatisfied: true, shouldContinue: false }
        const partialData = event.data as Partial<z.infer<typeof ResponseSchema>>;

        // Stream the thinking first (reasoning-first), then the reply.
        if (partialData.reasoning) {
          lastReasoningLength = streamField(
            partialData.reasoning,
            lastReasoningLength,
            "💭 [Thinking] ",
          );
        }

        if (partialData.response) {
          // The first response chunk closes the thinking line and opens the reply line.
          if (lastResponseLength === 0 && lastReasoningLength > 0) process.stdout.write("\n");
          lastResponseLength = streamField(
            partialData.response,
            lastResponseLength,
            "🤖 [Agent Response] ",
          );
        }

        // When the stream ends (complete or error), close the current line.
        if (event.status !== "partial") {
          process.stdout.write("\n");
        }
      }
    });

    // Call LLM to generate response: prior history + latest user message go in as
    // Messages, streaming output will be passed in real-time through onStream.
    // `delta` is the model's actual output (in schema mode: the raw JSON envelope,
    // plus any tool / validation-retry round-trips) — we persist it verbatim below.
    const { data: decision, delta } = await promptChat({
      message: [...conversationHistory, { role: "user", content: userMessage }],
      schema: ResponseSchema,
    });

    // reasoning + response were already streamed above; only log the decision flags
    // here to avoid printing the same text twice.
    console.log(`✅ [User Satisfied] ${decision.isSatisfied ? "Yes" : "No"}`);
    console.log(`🔄 [Continue Conversation] ${decision.shouldContinue ? "Yes" : "No"}`);

    // ============ Logic Processing ============

    // Update conversation history.
    // We persist the user turn plus `delta` (the model's actual output) verbatim,
    // rather than rebuilding an assistant message from the extracted `response`
    // string. Reason: in schema mode the model is asked to emit a JSON envelope,
    // so the assistant turns replayed as history MUST be in that same format. If we
    // instead stored a bare `response` string, every prior assistant turn would
    // become an in-context example showing "assistant replies with plain text",
    // which contradicts the schema instruction — and in-context examples win, so the
    // model drifts to ignoring the schema and emitting raw strings. Persisting delta
    // keeps the few-shot history self-consistent with the schema. It is also the only
    // complete record once tools are equipped (tool_calls / tool round-trips).
    const newHistory: Message[] = [
      ...conversationHistory,
      { role: "user", content: userMessage },
      ...delta,
    ];

    const newTurnCount = turnCount + 1;
    const newUserSatisfied = decision.isSatisfied || userSatisfied;

    // Update memory
    setConversationHistory(newHistory);
    setTurnCount(newTurnCount);
    setUserSatisfied(newUserSatisfied);

    // If user is satisfied and doesn't need to continue, return result
    if (newUserSatisfied && !decision.shouldContinue) {
      console.log(`\n🎉 [Conversation Ended] User satisfied, total ${newTurnCount} turns`);
      console.log(`\n${"=".repeat(50)}`);
      console.log("📋 Complete Conversation History:");
      newHistory.forEach((msg, idx) => {
        const role = msg.role === "user" ? "👤 User" : "🤖 Agent";
        console.log(`${idx + 1}. ${role}: ${renderMessageText(msg)}`);
      });

      return {
        conversationHistory: newHistory,
        turnCount: newTurnCount,
        isSatisfied: true,
      };
    }

    // If need to continue conversation, use reborn to wait for next user input
    console.log(`\n⏸️  [Waiting for Next Turn] Conversation continuing...`);
    return reborn(); // Re-execute handler, will call userInput() again
  },
});
