import { describe, expect, it } from "vitest";
import { isTestOrGeneratedPath } from "./sourcePath";

describe("isTestOrGeneratedPath", () => {
  it("flags test, fixture, declaration and generated paths", () => {
    expect(isTestOrGeneratedPath("src/foo.test.ts")).toBe(true);
    expect(isTestOrGeneratedPath("src/__fixtures__/bar.ts")).toBe(true);
    expect(isTestOrGeneratedPath("src/types/api.d.ts")).toBe(true);
    expect(isTestOrGeneratedPath("src/generated/client.ts")).toBe(true);
    expect(isTestOrGeneratedPath("src/services/foo.ts")).toBe(false);
  });
});
