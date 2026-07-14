import "dotenv/config";
import * as readline from "node:readline";
import { createMockModel } from "@rejelly/core/testing"; // __REJELLY_IMPORT__
import { createRouterAgent } from "./router-agent";

// __REJELLY_DEFAULT_ADAPTER_START__ - removed when create-rejelly injects a real adapter
const _mockModel = createMockModel();
_mockModel.setDefaultResponse({
  reason: "Replace with a real model adapter (run create-rejelly and choose OpenAI or Gemini).",
  target: "other",
});
// __REJELLY_DEFAULT_ADAPTER_END__

const model = _mockModel.adapter; // __REJELLY_MODEL__
const RouterAgent = createRouterAgent(model);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (prompt: string) => new Promise<string>((resolve) => rl.question(prompt, resolve));

async function main() {
  console.log("Rejelly Router — enter a request and the butler will route it.\n");

  try {
    const input = await ask("You: ");
    const reply = await RouterAgent({ userInput: input.trim() || "(empty)" });
    console.log("Bot:", reply);
  } catch (err) {
    console.error(err);
  } finally {
    rl.close();
  }
}

main();
