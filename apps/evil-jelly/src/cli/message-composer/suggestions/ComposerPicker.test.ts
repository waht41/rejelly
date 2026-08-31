import { describe, expect, it } from "vitest";
import { composerPickerItemCommand } from "./ComposerPicker";

const noItemKey = { return: false, tab: false, rightArrow: false };

describe("composerPickerItemCommand", () => {
  it("completes files with Tab even when they are not browseable", () => {
    expect(
      composerPickerItemCommand({ ...noItemKey, tab: true }, { complete: true, browse: false }),
    ).toBe("complete");
  });

  it("uses Right Arrow only for browseable items", () => {
    expect(
      composerPickerItemCommand(
        { ...noItemKey, rightArrow: true },
        { complete: true, browse: false },
      ),
    ).toBeNull();
    expect(
      composerPickerItemCommand(
        { ...noItemKey, rightArrow: true },
        { complete: true, browse: true },
      ),
    ).toBe("browse");
  });
});
