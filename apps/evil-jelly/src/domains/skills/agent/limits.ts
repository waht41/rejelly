export const SKILL_AGENT_LIMITS = Object.freeze({
  explicitSkillsPerTurn: 8,
  skillToolOutputChars: 160 * 1024,
  listToolOutputChars: 32 * 1024,
  resourceToolOutputChars: 160 * 1024,
  toolErrorMessageChars: 1_000,
} as const);
