import { beforeEach, describe, expect, it } from "vitest";
import { resetComposerSession, useComposerSession } from "./composerSession";

describe("composer session bridge", () => {
  beforeEach(resetComposerSession);

  it("forwards a materialized draft without owning its state", () => {
    const received: unknown[] = [];
    useComposerSession.getState().setBackgroundLineHandler((value) => received.push(value));
    const input = {
      document: [
        { type: "token" as const, kind: "skill" as const, qualifiedName: "project:review" },
        { type: "text" as const, text: " inspect " },
        { type: "token" as const, kind: "file" as const, attachmentId: "file-1" },
      ],
      attachments: [{ id: "file-1", kind: "file" as const, path: "src/a.ts" }],
    };

    useComposerSession.getState().submitLine(input);

    expect(received).toEqual([input]);
  });

  it("sorts available skills for the composer", () => {
    useComposerSession.getState().setAvailableSkills([
      { qualifiedName: "project:z", name: "z", scope: "project", description: "z" },
      { qualifiedName: "project:a", name: "a", scope: "project", description: "a" },
    ]);

    expect(
      useComposerSession.getState().availableSkills.map((skill) => skill.qualifiedName),
    ).toEqual(["project:a", "project:z"]);
  });
});
