export const STARTUP_PROFILE_ENV = "EVIL_STARTUP_PROFILE";
export const STARTUP_PROFILE_DRILLDOWN_ENV = "EVIL_STARTUP_PROFILE_DRILLDOWN";

export type StartupProfileDrilldown = "imports";

export function startupProfileEnabled(): boolean {
  // biome-ignore lint/style/noProcessEnv: profiling must be switchable before config/env loading.
  const value = process.env[STARTUP_PROFILE_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export function startupProfileDrilldown(): StartupProfileDrilldown | undefined {
  // biome-ignore lint/style/noProcessEnv: profiling must be switchable before config/env loading.
  const value = process.env[STARTUP_PROFILE_DRILLDOWN_ENV]?.trim().toLowerCase();
  return value === "imports" ? "imports" : undefined;
}
