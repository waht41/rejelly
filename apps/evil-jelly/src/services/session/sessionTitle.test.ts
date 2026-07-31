import { describe, expect, it } from "vitest";
import { deriveSessionTitle, deriveSessionTitleFromMessages } from "./sessionTitle";

describe("sessionTitle", () => {
  it("uses structured display text instead of attachment payload bodies", () => {
    expect(
      deriveSessionTitle({
        role: "user",
        content: "inspect\n\n<attached_file>large body</attached_file>",
        extra: {
          rejelly: {
            kind: "user_input",
            display: { text: "inspect", attachments: [] },
          },
        },
      }),
    ).toBe("inspect");
  });

  it("unwraps legacy compact projections only on the V1 messages path", () => {
    const message = {
      role: "user" as const,
      content: "<prior_user_message>\nfix sessions\n</prior_user_message>",
    };

    expect(deriveSessionTitle(message)).toBe(
      "<prior_user_message> fix sessions </prior_user_message>",
    );
    expect(deriveSessionTitleFromMessages([message])).toBe("fix sessions");
  });

  it("ignores compaction bridge messages and truncates the first real user title", () => {
    expect(
      deriveSessionTitleFromMessages([
        {
          role: "user",
          content: "internal compact summary",
          extra: { rejelly: { kind: "compaction_bridge" } },
        },
        { role: "user", content: "x".repeat(100) },
      ]),
    ).toBe(`${"x".repeat(79)}…`);
  });
});
