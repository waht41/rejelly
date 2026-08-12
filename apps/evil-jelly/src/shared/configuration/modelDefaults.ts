export const DEFAULT_OPENAI_MODEL_ID = "gpt-5.6-luna";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
/** Default real model context window when the provider does not declare one. */
export const DEFAULT_OPENAI_CONTEXT_WINDOW_TOKENS = 200_000;
/** Tool-heavy compaction is not supported below this provider context window. */
export const MIN_OPENAI_CONTEXT_WINDOW_TOKENS = 32_000;
/** Windows below this remain supported, but run with a reduced retained-user budget. */
export const LOW_OPENAI_CONTEXT_WINDOW_TOKENS = 50_000;
