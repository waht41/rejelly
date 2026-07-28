import type { Message } from "@rejelly/core";
import { describe, expect, it } from "vitest";
import type { EvilJellyHostBindings } from "../../shared/types";
import { seedHistoryIntoView } from "./resume";

function createBindings() {
  const calls: {
    users: string[];
    assistants: string[];
    systems: string[];
    tools: Parameters<EvilJellyHostBindings["logToolBlock"]>[0][];
  } = {
    users: [],
    assistants: [],
    systems: [],
    tools: [],
  };
  const bindings: EvilJellyHostBindings = {
    getInput: async () => ({ text: "", attachments: [] }),
    printOut: () => {},
    logUserMessage: (message) => calls.users.push(message),
    logAssistantMessage: (message) => calls.assistants.push(message),
    logSystemEvent: (message) => calls.systems.push(message),
    logToolBlock: (block) => calls.tools.push(block),
    confirmTool: async () => ({ ok: false, action: "reject" }),
    requestChoice: async () => "",
  };
  return { bindings, calls };
}

describe("seedHistoryIntoView", () => {
  it("reconstructs persisted tool messages into host tool blocks for transcript overlay", () => {
    const { bindings, calls } = createBindings();
    const history: Message[] = [
      { role: "user", content: "read package" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", name: "read_file", arguments: '{"filePaths":["package.json"]}' },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: '{\n  "name": "demo"\n}',
      },
      { role: "assistant", content: '{"reply":"package name is demo"}' },
    ];

    seedHistoryIntoView(bindings, "session_1", history);

    expect(calls.users).toEqual(["read package"]);
    expect(calls.tools).toHaveLength(1);
    expect(calls.tools[0]).toMatchObject({
      toolName: "read_file",
      fullResult: '{\n  "name": "demo"\n}',
      ok: true,
    });
    expect(calls.tools[0]?.summary).toContain("read_file");
    expect(calls.assistants).toEqual(["package name is demo"]);
    expect(calls.systems[0]).toContain("Resumed session session_1");
  });

  it("renders compaction as a system boundary instead of a user message", () => {
    const { bindings, calls } = createBindings();
    const history: Message[] = [
      {
        role: "user",
        content: "<prior_user_message>\nfix the session store\n</prior_user_message>",
      },
      {
        role: "user",
        content:
          "[Context was automatically compacted to fit the model window.]\n\n" +
          "<compaction_summary>\nprivate internal summary\n</compaction_summary>",
      },
      { role: "assistant", content: '{"reply":"Continuing the work."}' },
    ];

    seedHistoryIntoView(bindings, "session_compacted", history);

    expect(calls.users).toEqual(["fix the session store"]);
    expect(calls.assistants).toEqual(["Continuing the work."]);
    expect(calls.systems).toContain("Context was compacted in a previous run.\n");
    expect(calls.systems.at(-1)).toContain("Resumed session session_compacted (1 prior turns)");
    expect(calls.users.join("\n")).not.toContain("private internal summary");
  });
});
