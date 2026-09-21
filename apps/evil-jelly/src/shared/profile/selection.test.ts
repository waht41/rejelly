import { afterEach, describe, expect, it } from "vitest";
import {
  composerProfileEnabled,
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

describe("profile selection", () => {
  it("parses comma-separated selectors in order and removes duplicates", () => {
    expect(parseProfileSelectors("composer, startup:imports, startup, composer")).toEqual([
      "composer",
      "startup:imports",
      "startup",
    ]);
  });

  it("rejects empty and unavailable selectors with the available list", () => {
    expect(() => parseProfileSelectors("")).toThrow(
      'Unknown profile selector "". Available: startup, startup:bootstrap, startup:imports, startup:ink, composer.',
    );
    expect(() => parseProfileSelectors("startup:runtime")).toThrow(
      'Unknown profile selector "startup:runtime". Available: startup, startup:bootstrap, startup:imports, startup:ink, composer.',
    );
  });

  it.each(["1", "true", "TRUE"])("maps EVIL_PROFILE=%s to the startup view", (value) => {
    process.env[PROFILE_ENV] = value;

    expect(startupProfileEnabled()).toBe(true);
    expect(composerProfileEnabled()).toBe(false);
    expect(selectedStartupProfileViews()).toEqual(["startup"]);
  });

  it.each(["", "0", "false", "FALSE"])("treats EVIL_PROFILE=%s as disabled", (value) => {
    process.env[PROFILE_ENV] = value;

    expect(startupProfileEnabled()).toBe(false);
    expect(composerProfileEnabled()).toBe(false);
  });

  it("selects composer profiling without starting the startup timeline", () => {
    process.env[PROFILE_ENV] = "composer";

    expect(composerProfileEnabled()).toBe(true);
    expect(startupProfileEnabled()).toBe(false);
    expect(selectedStartupProfileViews()).toEqual([]);
  });

  it("uses other environment values as multiple ordered selectors", () => {
    process.env[PROFILE_ENV] = "startup:imports,composer,startup";

    expect(startupProfileEnabled()).toBe(true);
    expect(composerProfileEnabled()).toBe(true);
    expect(selectedStartupProfileViews()).toEqual(["startup:imports", "startup"]);
  });

  it("gives the CLI override priority over the environment", () => {
    process.env[PROFILE_ENV] = "startup";
    setProfileSelectorOverride(["composer"]);

    expect(composerProfileEnabled()).toBe(true);
    expect(startupProfileEnabled()).toBe(false);
  });
});
