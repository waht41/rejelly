import type { Message } from "@rejelly/core";
import { describe, expect, it } from "vitest";
import type { EvilJellyBindings } from "../../../shared/host/bindings";
import { textPromptInput } from "../../../shared/model/prompt/promptInput";
import { buildLegacyResumeSeed, hydrateResumeSeed } from "./resume";

function createBindings() {
  const calls: {
    users: string[];
    assistants: string[];
    systems: string[];
    tools: Parameters<EvilJellyBindings["logToolBlock"]>[0][];
  } = {
    users: [],
    assistants: [],
    systems: [],
    tools: [],
  };
  const bindings: EvilJellyBindings = {
    getInput: async () => textPromptInput(""),
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

describe("hydrateResumeSeed", () => {
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

    hydrateResumeSeed(bindings, "session_1", buildLegacyResumeSeed(history));

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

    hydrateResumeSeed(bindings, "session_compacted", buildLegacyResumeSeed(history));

    expect(calls.users).toEqual(["fix the session store"]);
    expect(calls.assistants).toEqual(["Continuing the work."]);
    expect(calls.systems).toContain("Context was compacted in a previous run.\n");
    expect(calls.systems.at(-1)).toContain("Resumed session session_compacted (1 prior turns)");
    expect(calls.users.join("\n")).not.toContain("private internal summary");
  });

  it("uses structured user display metadata instead of replaying inline attachments", () => {
    const { bindings, calls } = createBindings();
    const history: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              'inspect this\n\n<attached_file path="secret.txt" action="read">\n' +
              "large private file body\n</attached_file>",
          },
          {
            type: "image",
            image: { url: "data:image/png;base64,very-large-payload", detail: "auto" },
          },
        ],
        extra: {
          rejelly: {
            kind: "user_input",
            display: {
              text: "inspect this",
              attachments: [
                { type: "file", label: "secret.txt", action: "read" },
                { type: "image", label: "[Image #1]", action: "attach" },
              ],
            },
          },
        },
      },
      { role: "assistant", content: '{"reply":"Done."}' },
    ];

    hydrateResumeSeed(bindings, "session_attachments", buildLegacyResumeSeed(history));

    expect(calls.users).toEqual(["inspect this\n  -> read secret.txt\n  -> attach [Image #1]"]);
    expect(calls.users[0]).not.toContain("large private file body");
    expect(calls.users[0]).not.toContain("base64");
  });

  it("passes full history to hydration while reporting only the scrollback tail as visible", () => {
    const { bindings, calls } = createBindings();
    const hydrated: Parameters<NonNullable<EvilJellyBindings["hydrateHistory"]>>[0][] = [];
    bindings.hydrateHistory = (items) => hydrated.push(items);
    const history: Message[] = Array.from({ length: 12 }, (_, index): Message[] => [
      { role: "user", content: `Question ${index}` },
      { role: "assistant", content: `Answer ${index}` },
    ]).flat();

    hydrateResumeSeed(bindings, "session_tail", buildLegacyResumeSeed(history));

    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]).toHaveLength(24);
    expect(hydrated[0]?.[0]).toMatchObject({ type: "user", content: "Question 0" });
    expect(calls.users).toEqual([]);
    expect(calls.assistants).toEqual([]);
    expect(calls.systems).toContain(
      "Showing the last 10 of 12 prior turns; earlier history remains saved in the session transcript.\n",
    );
  });
});
