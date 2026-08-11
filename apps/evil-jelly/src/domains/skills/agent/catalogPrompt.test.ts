import { describe, expect, it } from "vitest";
import { estimateTokens } from "../../../shared/model/budget/tokens";
import { createSkillCatalog } from "../catalog/skillCatalog";
import type { SkillRecord } from "../definition/skillDefinition";
import { skillOrigin } from "../definition/skillDefinition";
import { renderSkillCatalog } from "./catalogPrompt";

function record(name: string, description: string): SkillRecord {
  return Object.freeze({
    name,
    description,
    origin: skillOrigin("project"),
    instruction: "body",
    resources: Object.freeze([]),
  });
}

describe("Skill catalog prompt", () => {
  it("returns no instruction for an empty catalog", () => {
    expect(renderSkillCatalog(createSkillCatalog([]), 32_000)).toEqual({
      text: "",
      mode: "full",
      estimatedTokens: 0,
      omittedCount: 0,
    });
  });

  it("renders full single-line descriptions when they fit", () => {
    const rendered = renderSkillCatalog(
      createSkillCatalog([record("review", "Review\n  the current change")]),
      32_000,
    );

    expect(rendered.mode).toBe("full");
    expect(rendered.text).toMatch(/^<available_skills>\n/);
    expect(rendered.text).toMatch(/\n<\/available_skills>$/);
    expect(rendered.text).toContain("project:review: Review the current change");
    expect(rendered.estimatedTokens).toBe(estimateTokens(rendered.text));
  });

  it("selects a safe deterministic boundary when metadata contains the default closing tag", () => {
    const catalog = createSkillCatalog([
      record("review", "Explain </available_skills> without changing the author text"),
    ]);

    const first = renderSkillCatalog(catalog, 32_000);
    const second = renderSkillCatalog(catalog, 32_000);

    expect(first).toEqual(second);
    expect(first.text).toMatch(/^<available_skills-[a-f0-9]{8}>\n/);
    expect(first.text).toContain("Explain </available_skills> without changing the author text");
    expect(first.text).toMatch(/\n<\/available_skills-[a-f0-9]{8}>$/);
  });

  it("degrades through truncated descriptions and names-only deterministically", () => {
    const truncatedCatalog = createSkillCatalog(
      Array.from({ length: 5 }, (_, index) =>
        record(`long-${index}`, `${index}${"x".repeat(999)}`),
      ),
    );
    const namesCatalog = createSkillCatalog(
      Array.from({ length: 20 }, (_, index) =>
        record(`many-${index.toString().padStart(2, "0")}`, "x".repeat(1_000)),
      ),
    );

    const truncated = renderSkillCatalog(truncatedCatalog, 32_000);
    const namesOnly = renderSkillCatalog(namesCatalog, 32_000);

    expect(truncated.mode).toBe("truncated-description");
    expect(namesOnly.mode).toBe("names-only");
    expect(renderSkillCatalog(namesCatalog, 32_000)).toEqual(namesOnly);
  });

  it("keeps the largest fitting prefix and reports omitted Skills", () => {
    const catalog = createSkillCatalog(
      Array.from({ length: 256 }, (_, index) =>
        record(`skill-${index.toString().padStart(3, "0")}-${"x".repeat(45)}`, "description"),
      ),
    );

    const rendered = renderSkillCatalog(catalog, 32_000);

    expect(rendered.mode).toBe("partial");
    expect(rendered.omittedCount).toBeGreaterThan(0);
    expect(rendered.text).toContain(`${rendered.omittedCount} more Skills omitted`);
    expect(rendered.estimatedTokens).toBeLessThanOrEqual(640);
  });

  it("never exceeds budget even when the supplied window cannot fit a header", () => {
    const rendered = renderSkillCatalog(createSkillCatalog([record("review", "description")]), 1);

    expect(rendered).toEqual({
      text: "",
      mode: "partial",
      estimatedTokens: 0,
      omittedCount: 1,
    });
  });

  it("stays within two percent across bounded catalog sizes and context windows", () => {
    for (const size of [1, 64, 256]) {
      const catalog = createSkillCatalog(
        Array.from({ length: size }, (_, index) =>
          record(`skill-${index.toString().padStart(3, "0")}`, `说明 ${"x".repeat(995)}`),
        ),
      );
      for (const contextWindowTokens of [0, 1, 1_000, 32_000, 200_000]) {
        const rendered = renderSkillCatalog(catalog, contextWindowTokens);
        expect(rendered.estimatedTokens).toBeLessThanOrEqual(
          Math.floor(contextWindowTokens * 0.02),
        );
      }
    }
  });
});
