import {
  createAgent,
  equipMemory,
  equipSystem,
  type Message,
  type ModelAdapter,
  onStream,
  promptChat,
  reborn,
} from "@rejelly/core";
import { z } from "zod";

const ResponseSchema = z.object({
  reply: z.string().describe("The reply to the user"),
  done: z
    .boolean()
    .describe(
      "Set to true when the user wants to end the conversation (e.g. goodbye, exit, stop, or no more questions).",
    ),
});

export function createChatAgent(model: ModelAdapter) {
  return createAgent({
    id: "chat-agent",
    model,
    handler: async (props: {
      getInput: () => Promise<string>;
      onReply?: (reply: string) => void;
      onStream?: (
        data: Partial<{ reply: string; done: boolean }>,
        meta: { status: "partial" | "complete" | "error"; isValid: boolean },
      ) => void;
    }) => {
      const [history, setHistory] = equipMemory<Message[]>("history", []);

      equipSystem(
        "You are a friendly and helpful assistant. When the user says goodbye, wants to leave, or has no more questions, set done to true.",
      );

      const message = await props.getInput();

      if (props.onStream) {
        const handleStream = props.onStream;
        onStream(async (stream) => {
          for await (const event of stream) {
            if (event.type === "structured_data") {
              handleStream(event.data as Partial<z.infer<typeof ResponseSchema>>, {
                status: event.status,
                isValid: event.isValid,
              });
            }
          }
        });
      }

      // History and the current input go in as chat Messages, not instruction text.
      const userMessage: Message = { role: "user", content: message || "(empty)" };
      const {
        data: { reply, done },
        delta,
      } = await promptChat({
        message: [...history, userMessage],
        schema: ResponseSchema,
      });

      props.onReply?.(reply);

      // Persist the user turn plus `delta` (the model's actual output) verbatim,
      // instead of rebuilding the assistant turn from the extracted `reply` string.
      // In schema mode the model is asked to emit a JSON envelope, so the assistant
      // turns replayed as history must be in that same format — storing a bare `reply`
      // string would feed the model in-context examples that contradict the schema,
      // and it would drift toward emitting plain strings. `delta` keeps the history
      // self-consistent with the schema, and is also the only complete record once
      // tools are involved (tool_calls / tool round-trips).
      setHistory([...history, { role: "user", content: message }, ...delta]);

      if (done) return { reply, done: true };
      return reborn(props);
    },
  });
}
