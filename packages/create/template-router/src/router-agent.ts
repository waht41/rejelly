import {
  createAgent,
  equipInstruction,
  equipSystem,
  type ModelAdapter,
  promptAgent,
} from "@rejelly/core";
import { z } from "zod";

/**
 * Beginner-friendly Router Pattern: a digital butler that dispatches requests.
 * Core idea — Agent as a Function. The main Agent understands intent; code handles deterministic routing.
 */

const IntentSchema = z.object({
  reason: z.string().describe("Brief reason for dispatching to this agent"),
  target: z.enum(["chat", "cli", "life", "other"]).describe("Target category of the request"),
});

// --- 1. Sub-Agents (mock implementations — fill in your own logic later) ---

const ChatAgent = createAgent({
  id: "chat-specialist",
  handler: async (props: { query: string }) => {
    return `[Chat Specialist] Ready! I heard: "${props.query}". Use equipMemory to give me long-term memory.`;
  },
});

const CLIAgent = createAgent({
  id: "cli-specialist",
  handler: async (props: { command: string }) => {
    return `[CLI Specialist] Received command: "${props.command}". Register a real handler via equipTool to give me system-level abilities.`;
  },
});

const LifeAgent = createAgent({
  id: "life-specialist",
  handler: async (props: { task: string }) => {
    return `[Life Assistant] On it! For "${props.task}", grab a coffee first. Then wire up sub-agents (e.g. WeatherAgent) to extend my capabilities.`;
  },
});

// --- 2. Main Router Agent ---

export function createRouterAgent(model: ModelAdapter) {
  return createAgent({
    id: "main-router",
    model,
    handler: async (props: { userInput: string }) => {
      equipSystem(
        "You are a friendly digital butler that routes user requests to the most suitable specialist.",
      );
      equipInstruction(`Current user request: "${props.userInput}"`);

      // Framework validates LLM output against IntentSchema and retries until it matches.
      const decision = await promptAgent(IntentSchema);

      // Deterministic routing — stitching probabilistic LLM output with deterministic code
      switch (decision.target) {
        case "chat":
          return await ChatAgent({ query: props.userInput });

        case "cli":
          return await CLIAgent({ command: props.userInput });

        case "life":
          return await LifeAgent({ task: props.userInput });

        case "other":
          return `Sorry, because "${decision.reason}", I can't handle this yet. Try extending the RouterAgent's switch branches!`;

        default:
          return `Unexpected intent "${decision.target}". Please check the IntentSchema definition.`;
      }
    },
  });
}
