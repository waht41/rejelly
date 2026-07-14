/**
 * Framework Constants
 */

/**
 * Check if running in development or test mode
 *
 * Used for:
 * - Enabling dev warnings (e.g., schema field overwrite warnings)
 * - Debug logging
 * - Development-only features
 */
export const IS_DEV = process?.env?.NODE_ENV === "development" || process?.env?.NODE_ENV === "test";

/**
 * Check if running in production mode
 *
 * Used for:
 * - Disallowing snapshot injection and enableSnapshot in production
 */
export const IS_PROD = process?.env?.NODE_ENV === "production";
