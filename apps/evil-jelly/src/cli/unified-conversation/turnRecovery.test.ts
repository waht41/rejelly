import type { Message } from "@rejelly/core";
import { describe, expect, it } from "vitest";
import { UNKNOWN_TOOL_OUTCOME_CONTENT } from "../../domains/session/projection/sessionRecovery";
import { sanitizeInterruptedDelta } from "../../features/unified/context-management/interruptedDelta";
import { continuationPromptForHistory } from "./turnRecovery";

const toolRequest: Message = {
  role: "assistant",
  content: null,
  tool_calls: [
    { id: "cancelled", name: "run_command", arguments: "{}" },
    { id: "completed", name: "list_directory", arguments: "{}" },
  ],
};

function toolHistory(content: string): Message[] {
  return [
    { role: "user", content: "Inspect the workspace" },
    toolRequest,
    { role: "tool", tool_call_id: "cancelled", content },
    { role: "tool", tool_call_id: "completed", content: "README.md" },
  ];
}

describe("history-driven continuation prompts", () => {
  it.each([
    UNKNOWN_TOOL_OUTCOME_CONTENT,
    "exitCode=null status=aborted\n(no output)\nCommand aborted by user (/stop or Esc).",
    'Tool "run_command" execution failed: AbortError: user interrupted',
  ])("warns about interrupted tools even before a successful result (%s)", (content) => {
    const history = toolHistory(content);
    const prompt = continuationPromptForHistory(history);
    expect(prompt).toContain("partial side effects may have occurred");
    expect(
      continuationPromptForHistory([...history, { role: "user", content: prompt! }]),
    ).toBeUndefined();
  });

  it("recognizes tool outputs synthesized by live interruption recovery", () => {
    const history = sanitizeInterruptedDelta([toolRequest]);
    expect(continuationPromptForHistory(history)).toContain("partial side effects");
  });

  it.each([
    "exitCode=0 status=exited\nDone",
    "Command execution denied by user.",
    'Tool "run_command" execution failed: command failed',
    "exitCode=null status=timed_out\nTimed out",
  ])("does not add prompts for ordinary tool results (%s)", (content) => {
    expect(continuationPromptForHistory(toolHistory(content))).toBeUndefined();
  });

  it("uses only the latest context boundary, not an old interrupted tool", () => {
    const history = toolHistory(UNKNOWN_TOOL_OUTCOME_CONTENT);
    expect(
      continuationPromptForHistory([...history, { role: "user", content: "Try a different task" }]),
    ).toBeUndefined();
    expect(
      continuationPromptForHistory([
        ...history,
        toolRequest,
        { role: "tool", tool_call_id: "cancelled", content: "Done" },
        { role: "tool", tool_call_id: "completed", content: "Done" },
      ]),
    ).toBeUndefined();
  });

  it("nudges a committed assistant reply without changing a pending user request", () => {
    expect(
      continuationPromptForHistory([{ role: "user", content: "Original request" }]),
    ).toBeUndefined();
    expect(
      continuationPromptForHistory([{ role: "assistant", content: "Partial progress" }]),
    ).toContain("Continue the previous task");
  });
});
