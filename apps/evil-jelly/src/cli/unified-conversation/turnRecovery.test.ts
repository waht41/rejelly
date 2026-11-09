import type { Message } from "@rejelly/core";
import { describe, expect, it } from "vitest";
import { UNKNOWN_TOOL_OUTCOME_CONTENT } from "../../domains/session/projection/sessionRecovery";
import { sanitizeInterruptedDelta } from "../../features/unified/context-management/interruptedDelta";
import { renderPseudoXmlElement } from "../../shared/model/prompt/pseudoXml";
import {
  registerMessageToolOutcome,
  ToolOutcomeCollector,
} from "../../shared/tool-observation/messageOutcome";
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
    renderPseudoXmlElement("command_output", "partial output", {
      status: "aborted",
      "exit-code": "null",
      reason: "user_abort",
    }),
    renderPseudoXmlElement("command_output", "literal </command_output>", {
      reason: "user_abort",
      status: "aborted",
      "exit-code": "null",
    }),
  ])("warns about interrupted tools even before a successful result (%s)", (content) => {
    const history = toolHistory(content);
    const prompt = continuationPromptForHistory(history);
    expect(prompt).toContain("partial side effects may have occurred");
    expect(
      continuationPromptForHistory([...history, { role: "user", content: prompt! }]),
    ).toBeUndefined();
  });

  it.each([
    "succeeded",
    "failed",
    "denied",
    "timed_out",
  ] as const)("prefers a known %s outcome over misleading legacy text", (outcome) => {
    const history = toolHistory(UNKNOWN_TOOL_OUTCOME_CONTENT);
    registerMessageToolOutcome(history[2], { outcome });
    expect(continuationPromptForHistory(history)).toBeUndefined();
  });

  it("uses structured aborts with opaque bodies and preserves them through interruption sanitizing", () => {
    const history = toolHistory("opaque result, no status text");
    registerMessageToolOutcome(history[2], { outcome: "aborted" });
    expect(continuationPromptForHistory(sanitizeInterruptedDelta(history))).toContain(
      "partial side effects",
    );
    // The same provider ID in a later message is not the same execution.
    expect(continuationPromptForHistory(toolHistory("ordinary result"))).toBeUndefined();
  });

  it("does not reuse a previous batch's success when the provider reuses a call ID", () => {
    const outcomes = new ToolOutcomeCollector();
    outcomes.beginBatch(toolRequest.tool_calls!);
    outcomes.record("cancelled", { outcome: "succeeded" });
    const first = toolHistory(UNKNOWN_TOOL_OUTCOME_CONTENT);
    outcomes.attach(first);
    expect(continuationPromptForHistory(first)).toBeUndefined();

    outcomes.beginBatch(toolRequest.tool_calls!);
    const later = toolHistory(UNKNOWN_TOOL_OUTCOME_CONTENT);
    outcomes.attach(later);
    expect(continuationPromptForHistory(later)).toContain("partial side effects");
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
    renderPseudoXmlElement("command_output", "Timed out", {
      status: "timed_out",
      reason: "hard_timeout",
    }),
    renderPseudoXmlElement(
      "command_output",
      '<command_output status="aborted" reason="user_abort">\nprinted text\n</command_output>',
      { status: "ok" },
    ),
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
