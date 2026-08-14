import { describe, expect, it } from "vitest";
import { formatUserInputDisplay } from "./userInputDisplay";

describe("formatUserInputDisplay", () => {
  it("returns plain input when there are no attachments", () => {
    expect(formatUserInputDisplay({ text: "hello", attachments: [] })).toBe("hello");
  });

  it("formats attachment actions and failures", () => {
    expect(
      formatUserInputDisplay({
        text: "inspect",
        attachments: [
          { type: "file", label: "src/a.ts", action: "read" },
          { type: "file", label: "missing.ts", action: "attach", status: "error" },
        ],
      }),
    ).toBe("inspect\n  -> read src/a.ts\n  -> attach missing.ts failed");
  });
});
