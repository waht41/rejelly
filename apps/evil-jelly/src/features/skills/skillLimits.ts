/** Central v1 safety and context limits for local plugin and skill loading. */
export const SKILL_LIMITS = Object.freeze({
  pluginManifestBytes: 64 * 1024,
  pluginManifestDepth: 16,
  contributionKindsPerPlugin: 16,
  skillFileBytes: 128 * 1024,
  frontmatterBytes: 16 * 1024,
  skillNameChars: 64,
  pluginIdChars: 128,
  descriptionChars: 1_000,
  listingDescriptionChars: 250,
  skillsPerPlugin: 128,
  skillsGlobal: 512,
  resourcesPerSkill: 256,
  listPageEntries: 50,
  listPageOutputChars: 16_000,
  resourceReadBytes: 100 * 1024,
} as const);
