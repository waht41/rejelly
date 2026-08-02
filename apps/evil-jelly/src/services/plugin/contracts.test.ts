import { describe, expect, it } from "vitest";
import {
  type ContributionProvenance,
  contributionOwnerId,
  PLUGIN_MANIFEST_FILE_NAME,
  qualifiedContributionName,
  UNSUPPORTED_PLUGIN_MANIFEST_FILE_NAME,
} from "./contracts";

describe("plugin manifest filename contract", () => {
  it("recognizes only plugin.jsonc and reserves plugin.json for a diagnostic", () => {
    expect(PLUGIN_MANIFEST_FILE_NAME).toBe("plugin.jsonc");
    expect(UNSUPPORTED_PLUGIN_MANIFEST_FILE_NAME).toBe("plugin.json");
  });
});

describe("plugin provenance contracts", () => {
  it("qualifies a formal plugin contribution with its stable plugin id", () => {
    const provenance: ContributionProvenance = {
      kind: "plugin",
      pluginId: "com.example.typescript",
      contributionKind: "skill",
      contributionId: "review-code",
    };

    expect(contributionOwnerId(provenance)).toBe("com.example.typescript");
    expect(qualifiedContributionName(provenance)).toBe("com.example.typescript:review-code");
  });

  it("qualifies a loose contribution without inventing a plugin id", () => {
    const provenance: ContributionProvenance = {
      kind: "loose",
      scope: "project",
      sourceId: "project-a1b2c3",
      contributionKind: "skill",
      contributionId: "review-code",
    };

    expect(contributionOwnerId(provenance)).toBe("project-a1b2c3");
    expect(qualifiedContributionName(provenance)).toBe("project-a1b2c3:review-code");
  });
});
