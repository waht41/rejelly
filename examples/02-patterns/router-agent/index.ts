/**
 * Router Pattern Example
 *
 * Intent recognition + dispatch: Zod for routing decision, native switch for sub-agent calls.
 */

import type { ExampleModule } from "@shared/types";
import { RouterAgent } from "./router-agent";

export const meta = {
  name: "Router",
  description: "Intent routing with Zod + switch; dispatch to Search/Code/Chat experts",
  order: 10,
};

async function runRouter(query: string) {
  console.log("Input:", query);
  console.log("---");
  const result = await RouterAgent({ input: query });
  console.log(`[${result.agent}]`, result.result);
  console.log("");
}

async function exampleSearch() {
  console.log("=== Router: search intent ===\n");
  await runRouter("What new models did OpenAI release recently?");
}

async function exampleCode() {
  console.log("=== Router: code intent ===\n");
  await runRouter("Write a debounce function in TypeScript");
}

async function exampleChat() {
  console.log("=== Router: casual chat ===\n");
  await runRouter("Nice weather today. What do you usually do on weekends?");
}

export const examples = {
  search: {
    title: "Router → Search expert",
    description: "Query that should route to search_expert",
    run: exampleSearch,
  },
  code: {
    title: "Router → Code expert",
    description: "Query that should route to code_expert",
    run: exampleCode,
  },
  chat: {
    title: "Router → Chat expert",
    description: "Query that should route to casual_chat",
    run: exampleChat,
  },
} satisfies ExampleModule["examples"];
