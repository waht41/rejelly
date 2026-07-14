/**
 * Chatty Customer Service Agent Usage Example
 *
 * Demonstrates how to use ChattyAgent for multi-turn conversations
 * Agent automatically handles user input internally, uses reborn to implement multi-turn conversations
 */

import type { ExampleModule } from "@shared/types";
import { ChattyAgent } from "./chatty-agent";

export const meta = {
  name: "Chat Agent",
  description: "Multi-turn conversations with reborn; agent handles user input internally",
  order: 10,
};

async function runChattyAgent() {
  console.log("🚀 Starting Chatty Customer Service Agent");
  console.log(
    "💡 Agent will automatically handle user input internally, using reborn to implement multi-turn conversations\n",
  );
  console.log("=".repeat(50));

  (global as any).__chattyAgentInputIndex = 0;

  try {
    const result = await ChattyAgent({
      userId: "user_123",
    });

    console.log(`\n${"=".repeat(50)}`);
    console.log("✅ Conversation ended");
    console.log(
      `📊 Statistics: Total ${result.turnCount} turns, User satisfied: ${result.isSatisfied ? "Yes" : "No"}`,
    );
  } catch (error) {
    console.error("❌ Error: ", error);
  }
}

export const examples = {
  default: {
    title: "Chatty Customer Service Agent",
    description: "Multi-turn conversation; agent uses userInput() and reborn() internally",
    run: runChattyAgent,
  },
} satisfies ExampleModule["examples"];
