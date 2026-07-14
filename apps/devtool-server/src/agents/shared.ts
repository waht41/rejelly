/**
 * Shared agent setup
 *
 * Common logic for the devtool AI agents: model adapter creation from
 * environment variables and self-trace review wiring.
 */

import { createOpenAIAdapter } from "@rejelly/adapter-openai";
import { enableReview } from "@rejelly/core/debugger";
import { getServerHost, getServerPort } from "../config";

const DEFAULT_MODEL_ID = "gpt-5.6-luna";

/**
 * Env vars the AI features cannot work without. OPENAI_MODEL_ID and
 * OPENAI_BASE_URL have usable defaults; the key does not (local gateways
 * that skip auth can set a placeholder value).
 */
const REQUIRED_AI_ENV_VARS = ["OPENAI_API_KEY"] as const;

export function getMissingAiEnvVars(): string[] {
  return REQUIRED_AI_ENV_VARS.filter((name) => !process.env[name]?.trim());
}

/**
 * Create the model adapter for devtool AI agents from environment variables.
 *
 * No cost calculation is wired in: model pricing is open-ended (private
 * gateways, custom billing) and goes stale quickly, and the devtool uses budget
 * data only for observability — never for credits or production billing. The
 * trace inspector therefore shows token counts and omits a (false-precision)
 * cost figure. See examples/shared/model-pricing.ts for a sample calculateCost.
 */
export function createDevtoolModel() {
  return createOpenAIAdapter({
    modelId: process.env.OPENAI_MODEL_ID || DEFAULT_MODEL_ID,
    apiKey: process.env.OPENAI_API_KEY || "",
    baseURL: process.env.OPENAI_BASE_URL,
  });
}

export type DevtoolModel = ReturnType<typeof createDevtoolModel>;

const DEVTOOL_REVIEW_ENABLE_SYMBOL = Symbol.for("rejelly.devtool.enableReview.once");

/**
 * Point the agents' own traces back at this server, once per process.
 *
 * Opt-in via `rejelly-devtool --review` (sets REJELLY_DEVTOOL_REVIEW=1). Off by
 * default regardless of NODE_ENV — the flag is the single source of truth. The
 * caller takes on the self-trace feedback loop: agent runs emit traces into the
 * same DB, tagged `devtool.source` so the UI can filter them out.
 */
export function enableDevtoolReviewOnce() {
  if (process.env.REJELLY_DEVTOOL_REVIEW !== "1") {
    return;
  }

  const globalState = globalThis as typeof globalThis & {
    [DEVTOOL_REVIEW_ENABLE_SYMBOL]?: boolean;
  };
  if (globalState[DEVTOOL_REVIEW_ENABLE_SYMBOL]) {
    return;
  }

  globalState[DEVTOOL_REVIEW_ENABLE_SYMBOL] = true;

  // Same resolved address @config hands the server, so self-tracing targets the
  // real bound port/host even when set via --port/--host CLI flags. A wildcard
  // bind (0.0.0.0 / ::) is not a connectable target, so dial the loopback when
  // posting traces back to ourselves.
  const host = getServerHost();
  const target = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const endpoint =
    process.env.REJELLY_REVIEW_ENDPOINT || `http://${target}:${getServerPort()}/api/v1/traces`;

  enableReview({ endpoint });
}
