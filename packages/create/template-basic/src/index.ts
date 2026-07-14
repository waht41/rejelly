import "dotenv/config";
import * as readline from "node:readline";
import { createMockModel } from "@rejelly/core/testing"; // __REJELLY_IMPORT__
import { createChatAgent } from "./chat-agent";

// __REJELLY_DEFAULT_ADAPTER_START__ - removed when create-rejelly injects a real adapter
const _mockModel = createMockModel();
_mockModel.setDefaultResponse({
  reply: "Replace with a real model adapter (run create-rejelly and choose OpenAI or Gemini).",
  done: true,
});
// __REJELLY_DEFAULT_ADAPTER_END__

const model = _mockModel.adapter; // __REJELLY_MODEL__
const ChatAgent = createChatAgent(model);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (prompt: string) => new Promise<string>((resolve) => rl.question(prompt, resolve));

async function main() {
  console.log("Rejelly Chat  (say goodbye to end)\n");

  let lastReplyLength = 0;
  try {
    const result = await ChatAgent({
      getInput: () => ask("You: ").then((s) => s.trim()),
      onStream: (data, meta) => {
        if (meta.isValid && data.reply !== undefined) {
          if (data.reply.length > lastReplyLength) {
            if (lastReplyLength === 0) process.stdout.write("Bot: ");
            process.stdout.write(data.reply.slice(lastReplyLength));
            lastReplyLength = data.reply.length;
          }
        }
        if (meta.status !== "partial") {
          process.stdout.write("\n");
          lastReplyLength = 0;
        }
      },
    });

    if (result.done) {
      console.log("Bye!");
    }
  } catch (err) {
    console.error(err);
  } finally {
    rl.close();
  }
}

main();
