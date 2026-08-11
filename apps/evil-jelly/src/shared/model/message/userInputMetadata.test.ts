import { describe, expect, it } from "vitest";
import {
  createUserInputMetadata,
  getUserInputDisplay,
  getUserInputImageDimensions,
} from "./userInputMetadata";

describe("user input metadata", () => {
  it("constructs and reads stable display and image metadata", () => {
    const display = {
      text: "inspect this",
      attachments: [{ type: "image" as const, label: "[Image #1]", action: "attach" as const }],
    };
    const message = {
      role: "user" as const,
      content: "inspect this",
      extra: {
        rejelly: createUserInputMetadata(display, [{ width: 640, height: 480 }, null]),
      },
    };

    expect(getUserInputDisplay(message)).toEqual(display);
    expect(getUserInputImageDimensions(message)).toEqual([{ width: 640, height: 480 }, undefined]);
  });

  it("rejects malformed persisted display metadata", () => {
    expect(
      getUserInputDisplay({
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
