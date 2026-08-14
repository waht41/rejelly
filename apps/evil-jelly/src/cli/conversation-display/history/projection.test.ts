import { describe, expect, it } from "vitest";
import { projectTranscriptItem } from "./projection";
import { HistorySequence } from "./sequence";

describe("projectTranscriptItem", () => {
  it("materializes attachment actions into resumed user history", () => {
    expect(
      projectTranscriptItem(
        {
          id: "user-1",
          type: "user",
          turnId: "turn-1",
          seq: 1,
          content: "inspect these",
          attachments: [
            {
              action: "read",
              label: "notes.txt",
              type: "file",
              locator: { path: "notes.txt", scope: "workspace" },
            },
          ],
        },
        new HistorySequence(),
      ),
    ).toEqual({
      id: "resume_user-1",
      type: "user",
      content: "inspect these\n  -> read notes.txt",
    });
  });

  it("builds a bounded preview for resumed tool output", () => {
    const turn = projectTranscriptItem(
      {
        id: "tool-1",
        type: "tool",
        turnId: "turn-1",
        seq: 2,
        toolCallId: "call-1",
        toolName: "shell",
        arguments: "  pnpm   test  ",
        result: "1\n2\n3\n4\n5\n6\n7",
        ok: true,
      },
      new HistorySequence(),
    );

    expect(turn.type).toBe("tool");
    if (turn.type === "tool") {
      expect(turn.content).toBe("[Tools] shell pnpm test (resumed)");
      expect(turn.tool.preview).toBe("1\n2\n3\n4\n5\n6");
      expect(turn.tool.ordinal).toBe(1);
    }
  });
});
