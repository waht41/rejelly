import { afterEach, describe, expect, it } from "vitest";
import {
  PROFILE_ENV,
  parseProfileSelectors,
  selectedStartupProfileViews,
  setProfileSelectorOverride,
  startupProfileEnabled,
} from "./selection";

const originalProfileEnv = process.env[PROFILE_ENV];

afterEach(() => {
  setProfileSelectorOverride(undefined);
  if (originalProfileEnv === undefined) {
    delete process.env[PROFILE_ENV];
  } else {
    process.env[PROFILE_ENV] = originalProfileEnv;
  }
});

describe("startup profile selection", () => {
  it("parses comma-separated selectors in order and removes duplicates", () => {
    expect(parseProfileSelectors("startup:imports, startup, startup:imports")).toEqual([
      "startup:imports",
      "startup",
    ]);
  });

  it("rejects empty and unavailable selectors with the available list", () => {
    expect(() => parseProfileSelectors("")).toThrow(
      'Unknown profile selector "". Available: startup, startup:imports, startup:ink.',
    );
    expect(() => parseProfileSelectors("startup:runtime")).toThrow(
      'Unknown profile selector "startup:runtime". Available: startup, startup:imports, startup:ink.',
    );
  });

  it.each(["1", "true", "TRUE"])("maps EVIL_PROFILE=%s to the startup view", (value) => {
    process.env[PROFILE_ENV] = value;

    expect(startupProfileEnabled()).toBe(true);
    expect(selectedStartupProfileViews()).toEqual(["startup"]);
  });

  it.each(["", "0", "false", "FALSE"])("treats EVIL_PROFILE=%s as disabled", (value) => {
    process.env[PROFILE_ENV] = value;

    expect(startupProfileEnabled()).toBe(false);
  });

  it("uses other environment values as multiple ordered selectors", () => {
    process.env[PROFILE_ENV] = "startup:imports,startup";

    expect(startupProfileEnabled()).toBe(true);
    expect(selectedStartupProfileViews()).toEqual(["startup:imports", "startup"]);
  });

  it("gives the CLI override priority over the environment", () => {
    process.env[PROFILE_ENV] = "startup";
    setProfileSelectorOverride(["startup:imports"]);

    expect(selectedStartupProfileViews()).toEqual(["startup:imports"]);
  });
});
