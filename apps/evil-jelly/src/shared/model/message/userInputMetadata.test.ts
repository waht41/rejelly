import type { Message } from "@rejelly/core";
import { describe, expect, it } from "vitest";
import {
  getLegacyUserInputDisplay,
  getRuntimeUserInputDisplay,
  getRuntimeUserInputImageDimensions,
  registerRuntimeUserInputMetadata,
} from "./userInputMetadata";

describe("user input metadata", () => {
  it("constructs and reads stable display and image metadata", () => {
    const display = {
      text: "inspect this",
      attachments: [{ type: "image" as const, label: "[Image #1]", action: "attach" as const }],
    };
    const message: Message = {
      role: "user",
      content: "inspect this",
    };
    registerRuntimeUserInputMetadata(message, display, [{ width: 640, height: 480 }, null]);

    expect(message.extra).toBeUndefined();
    expect(getRuntimeUserInputDisplay(message)).toEqual(display);
    expect(getRuntimeUserInputImageDimensions(message)).toEqual([
      { width: 640, height: 480 },
      undefined,
    ]);
  });

  it("rejects malformed persisted display metadata", () => {
    expect(
      getLegacyUserInputDisplay({
        role: "user",
        content: "raw fallback",
        extra: {
          rejelly: {
            kind: "user_input",
            display: {
              text: "shown text",
              attachments: [{ type: "file", label: "a.ts", action: "unknown" }],
            },
          },
        },
      }),
    ).toBeUndefined();
  });
});
