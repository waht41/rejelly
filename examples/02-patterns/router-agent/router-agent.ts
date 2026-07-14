/**
 * Router Pattern
 *
 * Intent recognition + dispatch: use Zod to force LLM to output a routing decision,
 * then use plain TypeScript switch/if to call the right sub-agent.
 * No Graph DSL — native control flow.
 */

import { createAgent, equipInstruction, equipSystem, promptAgent } from "@rejelly/core";
import { getModel } from "@shared/runtime-model";
import { z } from "zod";

// ----- Sub-agents (minimal mock experts; each returns a clearly identifiable string) -----
const model = getModel();

const SearchAgent = createAgent({
  id: "search_expert",
  model,
  handler: async (props: { task: string }): Promise<{ agent: "SearchExpert"; result: string }> => {
    return {
      agent: "SearchExpert",
      result: `Searching the web for "${props.task}"... (mock result)`,
    };
  },
});

const CodeAgent = createAgent({
  id: "code_expert",
  model,
  handler: async (props: { task: string }): Promise<{ agent: "CodeExpert"; result: string }> => {
    return {
      agent: "CodeExpert",
      result: `\`\`\`javascript\n// Code for "${props.task}"\nconsole.log("Hello Mock");\n\`\`\``,
    };
  },
});

const ChatAgent = createAgent({
  id: "casual_chat",
  model,
  handler: async (props: { message: string }): Promise<{ agent: "ChatBot"; result: string }> => {
    return {
      agent: "ChatBot",
      result: `Hi! I'm a casual chat assistant. You said: ${props.message}`,
    };
  },
});

// ----- Router: structured decision + native switch dispatch -----

const RouteSchema = z.object({
  route: z.enum(["search_expert", "code_expert", "casual_chat"]),
  reason: z.string(),
});

export type RouterResult =
  | { agent: "SearchExpert"; result: string }
  | { agent: "CodeExpert"; result: string }
  | { agent: "ChatBot"; result: string };

export const RouterAgent = createAgent({
  id: "router",
  model,
  handler: async (props: { input: string }): Promise<RouterResult> => {
    equipSystem(
      "You are a traffic router. Based on the user input, decide which expert to route to: search_expert (search/lookup), code_expert (code/tech), casual_chat (chitchat/other).",
    );
    equipInstruction(props.input);

    const decision = await promptAgent(RouteSchema);

    switch (decision.route) {
      case "search_expert":
        return await SearchAgent({ task: props.input });
      case "code_expert":
        return await CodeAgent({ task: props.input });
      default:
        return await ChatAgent({ message: props.input });
    }
  },
});
