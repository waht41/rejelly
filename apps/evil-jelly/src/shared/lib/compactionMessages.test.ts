import type { Message } from "@rejelly/core";
import { describe, expect, it } from "vitest";
import {
  COMPACTION_BRIDGE_MESSAGE_KIND,
  countConversationTurns,
  isCompactionBridgeMessage,
  unwrapPriorUserMessageText,
  withoutCompactionBridgeMarker,
} from "./compactionMessages";

describe("compaction message classification", () => {
  it("does not count the internal compaction bridge as a user turn", () => {
    const messages: Message[] = [
      { role: "user", content: "first task" },
      {
        role: "user",
        content: "<prior_user_message>\nsecond task\n</prior_user_message>",
      },
      {
        role: "user",
        content:
          "[Context was automatically compacted to fit the model window.]\n" +
          "<compaction_summary>summary</compaction_summary>",
      },
      { role: "assistant", content: "done" },
    ];

    expect(countConversationTurns(messages)).toBe(2);
    expect(isCompactionBridgeMessage(messages[2]!)).toBe(true);
  });

  it("unwraps retained historical user messages for display", () => {
    expect(
      unwrapPriorUserMessageText(
        "<prior_user_message>\nKeep this historical request visible.\n</prior_user_message>",
      ),
    ).toBe("Keep this historical request visible.");
    expect(unwrapPriorUserMessageText("ordinary user message")).toBe("ordinary user message");
  });

  it("prefers structured metadata while retaining legacy text detection", () => {
    const structured: Message = {
      role: "user",
      content: "A future bridge format with different text",
      extra: {
        providerHint: "keep",
        rejelly: { kind: COMPACTION_BRIDGE_MESSAGE_KIND },
      },
    };

    expect(isCompactionBridgeMessage(structured)).toBe(true);
    expect(
      isCompactionBridgeMessage({
        role: "user",
        content: "[Context was automatically compacted using the legacy format]",
      }),
    ).toBe(true);
    expect(withoutCompactionBridgeMarker(structured)).toEqual({
      role: "user",
      content: "A future bridge format with different text",
      extra: { providerHint: "keep" },
    });
  });
});
