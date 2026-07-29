import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAutoCompactionConfig } from "./contextControl";

const originalContextWindow = process.env.OPENAI_CONTEXT_WINDOW;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalContextWindow === undefined) {
    delete process.env.OPENAI_CONTEXT_WINDOW;
  } else {
    process.env.OPENAI_CONTEXT_WINDOW = originalContextWindow;
  }
});

describe("buildAutoCompactionConfig", () => {
  it("scales retained user context with the configured model window", () => {
    process.env.OPENAI_CONTEXT_WINDOW = "50000";
    expect(buildAutoCompactionConfig().keepRecentUserTokens).toBe(20000);

    process.env.OPENAI_CONTEXT_WINDOW = "128000";
    expect(buildAutoCompactionConfig().keepRecentUserTokens).toBe(40960);

    process.env.OPENAI_CONTEXT_WINDOW = "200000";
    expect(buildAutoCompactionConfig().keepRecentUserTokens).toBe(64000);
  });

  it("drops the 20k floor and warns once for supported windows below 50k", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.env.OPENAI_CONTEXT_WINDOW = "32000";

    expect(buildAutoCompactionConfig().keepRecentUserTokens).toBe(10240);
    expect(buildAutoCompactionConfig().keepRecentUserTokens).toBe(10240);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("below 50000"));
  });
});
