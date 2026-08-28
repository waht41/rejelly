export const PROFILE_ENV = "EVIL_PROFILE";

export const PROFILE_SELECTORS = ["startup", "startup:imports"] as const;
export type ProfileSelector = (typeof PROFILE_SELECTORS)[number];

let selectorOverride: readonly ProfileSelector[] | undefined;

export function parseProfileSelectors(raw: string): readonly ProfileSelector[] {
  const selectors: ProfileSelector[] = [];
  for (const part of raw.split(",")) {
    const selector = part.trim();
    if (!PROFILE_SELECTORS.includes(selector as ProfileSelector)) {
      throw new Error(
        `Unknown profile selector "${selector}". Available: ${PROFILE_SELECTORS.join(", ")}.`,
      );
    }
    if (!selectors.includes(selector as ProfileSelector)) {
      selectors.push(selector as ProfileSelector);
    }
  }
  return selectors;
}

/** CLI selection outranks the environment for this process invocation. */
export function setProfileSelectorOverride(
  selectors: readonly ProfileSelector[] | undefined,
): void {
  selectorOverride = selectors;
}

function environmentProfileSelectors(): readonly ProfileSelector[] | undefined {
  // biome-ignore lint/style/noProcessEnv: profiling must be selectable before config/env loading.
  const raw = process.env[PROFILE_ENV]?.trim();
  if (!raw) return undefined;
  const normalized = raw.toLowerCase();
  if (normalized === "0" || normalized === "false") return undefined;
  if (normalized === "1" || normalized === "true") return ["startup"];
  return parseProfileSelectors(raw);
}

export function startupProfileEnabled(): boolean {
  return selectorOverride !== undefined || environmentProfileSelectors() !== undefined;
}

/** No explicit selector means the existing top-level startup view. */
export function selectedStartupProfileViews(): readonly ProfileSelector[] {
  return selectorOverride ?? environmentProfileSelectors() ?? ["startup"];
}
