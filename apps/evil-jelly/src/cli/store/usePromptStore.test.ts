import { describe, expect, it } from "vitest";
import { resetPromptSession, usePromptStore } from "./usePromptStore";

describe("usePromptStore file attachments", () => {
  it("passes selected files to the background line handler as attachments", () => {
    resetPromptSession();
    const received: unknown[] = [];
    usePromptStore.getState().setBackgroundLineHandler((value) => {
      received.push(value);
    });

    usePromptStore.getState().toggleSelectedFile("src/a.ts");
    usePromptStore.getState().toggleSelectedFile("src/b.ts");
    usePromptStore.getState().submitLine("read these files");

    expect(received).toEqual([
      {
        text: "read these files",
        attachments: [
          { type: "file", path: "src/a.ts" },
          { type: "file", path: "src/b.ts" },
        ],
      },
    ]);
  });

  it("supports toggling and removing selected files", () => {
    resetPromptSession();

    usePromptStore.getState().toggleSelectedFile("src/a.ts");
    usePromptStore.getState().toggleSelectedFile("src/b.ts");
    usePromptStore.getState().toggleSelectedFile("src/a.ts");

    expect(usePromptStore.getState().selectedFiles).toEqual(["src/b.ts"]);

    usePromptStore.getState().removeSelectedFile("src/b.ts");
    expect(usePromptStore.getState().selectedFiles).toEqual([]);
  });

  it("passes selected images to the background line handler as attachments", () => {
    resetPromptSession();
    const received: unknown[] = [];
    usePromptStore.getState().setBackgroundLineHandler((value) => {
      received.push(value);
    });

    usePromptStore.getState().addSelectedImage("C:\\Temp\\clipboard.png");
    usePromptStore.getState().submitLine("inspect this");

    expect(received).toEqual([
      {
        text: "inspect this",
        attachments: [
          {
            type: "image",
            path: "C:\\Temp\\clipboard.png",
            mimeType: "image/png",
          },
        ],
      },
    ]);
  });
});

describe("usePromptStore Skill references", () => {
  it("submits de-duplicated structured picker selections", () => {
    resetPromptSession();
    const received: unknown[] = [];
    usePromptStore.getState().setBackgroundLineHandler((value) => received.push(value));
    usePromptStore
      .getState()
      .setSelectedSkills([
        { qualifiedName: "project:review" },
        { qualifiedName: "project:review" },
      ]);

    usePromptStore.getState().submitLine("$project:review inspect");

    expect(received).toEqual([
      {
        text: "$project:review inspect",
        attachments: [],
        skills: [{ qualifiedName: "project:review" }],
      },
    ]);
  });
});
