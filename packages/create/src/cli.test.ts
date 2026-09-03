import { describe, expect, it } from "vitest";
import { applyDefaults, assertCompleteOptions, getMissingOptions, parseCliArgs } from "./cli";

describe("create-rejelly CLI", () => {
  it("parses complete non-interactive arguments", () => {
    expect(parseCliArgs(["my-app", "--template", "router", "--adapter=gemini"])).toEqual({
      projectName: "my-app",
      template: "router",
      adapter: "gemini",
      help: false,
      yes: false,
    });
  });

  it("supports short options and --yes", () => {
    expect(parseCliArgs(["my-app", "-t", "basic", "-a", "openai", "-y"])).toEqual({
      projectName: "my-app",
      template: "basic",
      adapter: "openai",
      help: false,
      yes: true,
    });
  });

  it("rejects invalid and unknown options", () => {
    expect(() => parseCliArgs(["--template", "missing"])).toThrow(
      'Invalid template "missing". Expected: basic or router.',
    );
    expect(() => parseCliArgs(["--unknown"])).toThrow('Unknown option "--unknown".');
  });

  it("reports every missing value for non-interactive mode", () => {
    const options = parseCliArgs(["my-app"]);
    expect(getMissingOptions(options)).toEqual(["template", "adapter"]);
    expect(() => assertCompleteOptions(options)).toThrow(
      "Missing required options in non-interactive mode: template, adapter.",
    );
  });

  it("applies defaults only when requested by the caller", () => {
    expect(applyDefaults(parseCliArgs(["custom", "--yes"]))).toEqual({
      projectName: "custom",
      template: "basic",
      adapter: "openai",
    });
  });
});
