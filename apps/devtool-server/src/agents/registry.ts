/**
 * Shared agent registry - lazily constructs the devtool AI agents once per
 * process and hands the same instances to every request.
 *
 * Lazy because the OpenAI client throws when constructed without an apiKey;
 * the server must still boot (and 503 the AI routes) when the key is missing.
 * A single instance allows connection pool reuse across requests.
 */

import { createAnalyzeAgent } from "./analyze-agent";
import { createFilterAgent } from "./filter-agent";
import { createDevtoolModel } from "./shared";

let sharedAgents: {
  analyze: ReturnType<typeof createAnalyzeAgent>;
  filter: ReturnType<typeof createFilterAgent>;
} | null = null;

export function getSharedAgents() {
  if (!sharedAgents) {
    const model = createDevtoolModel();
    sharedAgents = {
      analyze: createAnalyzeAgent(model),
      filter: createFilterAgent(model),
    };
  }
  return sharedAgents;
}
