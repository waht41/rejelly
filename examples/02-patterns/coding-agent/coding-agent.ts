/**
 * Coding Agent Pattern
 *
 * A minimal-but-real coding agent: explore → edit → run → verify, in a
 * sandboxed workspace. The agent itself is this file — the loop is just
 * `promptChat` with tools equipped; there is no plan/act state machine to
 * maintain.
 *
 * What to look at:
 * - The tool loop is free: equip tools, call promptChat once, and the
 *   model-decides/execute/feed-back cycle runs until the model answers in text
 *   (bounded by maxTurnSteps).
 * - Policy is middleware, not tool code: only mutating tools get the approval
 *   gate, and the split is one visible line in the equip loop below.
 * - The system prompt enforces the one habit that separates a coding agent
 *   from a code generator: run the code after changing it.
 */

import { createAgent, equipSystem, equipTool, onStream, promptChat } from "@rejelly/core";
import { getModel } from "@shared/runtime-model";
import { consoleToolLogger, createApprovalGate } from "./approval";
import { createCodingTools, MUTATING_TOOL_NAMES } from "./tools";

const model = getModel();

const SYSTEM_PROMPT = `You are a coding agent working inside a sandboxed workspace. All file paths are relative to the workspace root; you cannot touch anything outside it.

Working rules:
- Orient first: use list_files / read_file before changing anything.
- Prefer edit_file (exact unique match) for small changes; write_file for new files or full rewrites.
- After ANY change, verify it by executing code with run_command (e.g. \`node file.js\`). Never claim success without having seen the command output.
- If a command fails or a tool is denied, read the output, adapt, and try again.
- When the task is done and verified, reply with a short plain-text summary: what changed, and how you verified it.`;

export interface CodingAgentProps {
  /** The coding task, in natural language. */
  task: string;
  /** Absolute path of the sandbox workspace the tools are bound to. */
  workspace: string;
  /** Skip the y/N approval prompts on mutating tools. */
  autoApprove?: boolean;
}

export interface CodingAgentResult {
  /** The agent's final plain-text summary. */
  summary: string;
}

export const CodingAgent = createAgent<CodingAgentProps, CodingAgentResult>({
  id: "coding_agent",
  model,
  // A coding task takes many model turns (explore, edit, run, retry). The
  // default budget is sized for Q&A; raise it and let the loop breathe.
  maxTurnSteps: 24,
  handler: async (props) => {
    equipSystem(SYSTEM_PROMPT);

    // The policy split, in one line per tool: read-only tools run freely,
    // mutating tools go through the approval gate. Logger sits outside the
    // gate so denied attempts still show up in the transcript.
    const approvalGate = createApprovalGate({ autoApprove: props.autoApprove });
    for (const tool of createCodingTools(props.workspace)) {
      equipTool(tool, {
        middleware: MUTATING_TOOL_NAMES.has(tool.name)
          ? [consoleToolLogger, approvalGate]
          : [consoleToolLogger],
      });
    }

    // Stream the model's text (its narration between tool calls and the final
    // summary) to the terminal as it is generated.
    onStream(async (stream) => {
      let inText = false;
      for await (const event of stream) {
        if (event.type === "text") {
          if (!inText) {
            process.stdout.write("\n💬 ");
            inText = true;
          }
          process.stdout.write(event.delta);
        } else if (event.type === "turn_done" && inText) {
          process.stdout.write("\n");
          inText = false;
        }
      }
    });

    // This one call IS the agent loop: model decides → tools execute → results
    // feed back → repeat, until the model answers in plain text.
    const { data: summary } = await promptChat({
      message: { role: "user", content: props.task },
    });

    return { summary };
  },
});
