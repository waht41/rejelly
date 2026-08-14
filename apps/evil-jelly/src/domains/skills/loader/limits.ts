export const SKILL_LOADER_LIMITS = Object.freeze({
  skillFileBytes: 128 * 1024,
  frontmatterBytes: 16 * 1024,
  frontmatterDepth: 16,
  descriptionChars: 1_000,
  skillsPerSource: 128,
  resourcesPerSkill: 256,
  resourceDirectoryDepth: 8,
  resourceReadBytes: 100 * 1024,
} as const);
