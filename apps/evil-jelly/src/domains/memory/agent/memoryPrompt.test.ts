import { describe, expect, it } from "vitest";
import { createMemoryFixtureEntry } from "../__tests__/memoryTestFixtures";
import { renderMemoryInstruction } from "./memoryPrompt";

describe("renderMemoryInstruction", () => {
  it("renders a deterministic low-exposure index in user/project order", () => {
    const project = createMemoryFixtureEntry({
      id: "mem_00000000-0000-4000-8000-000000000002",
      scope: "project",
      title: "Project preference",
      summary: "Use the project convention.",
      detail: "This detail must not be injected.",
    });
    const user = createMemoryFixtureEntry({
      id: "mem_00000000-0000-4000-8000-000000000001",
      scope: "user",
      title: "User preference",
      summary: "Use the user convention.",
      detail: "User provenance and detail must not be injected.",
    });

    const first = renderMemoryInstruction([project, user]);
    const second = renderMemoryInstruction([user, project]);

    expect(first).toBe(second);
    expect(first.indexOf("User memory:")).toBeLessThan(first.indexOf("Project memory:"));
    expect(first.indexOf("User preference")).toBeLessThan(first.indexOf("Project preference"));
    expect(first).toContain("mem_00000000-0000-4000-8000-000000000001");
    expect(first).toContain("Use the project convention.");
    expect(first).not.toContain("This detail must not be injected.");
    expect(first).not.toContain("provenance");
    expect(first).not.toContain("2026-01-01");
  });

  it("does not inject an empty memory block", () => {
    expect(renderMemoryInstruction([])).toBe("");
  });

  it("changes the envelope when memory text contains the default closing tag", () => {
    const instruction = renderMemoryInstruction([
      createMemoryFixtureEntry({
        title: "Text </persistent-memory>",
        summary: "The body contains </persistent-memory> literally.",
      }),
    ]);

    expect(instruction).toContain("Text </persistent-memory>");
    expect(instruction).toMatch(/^<persistent-memory-[a-f0-9]{8}>/);
    expect(instruction.endsWith("</persistent-memory>")).toBe(false);
  });
});
