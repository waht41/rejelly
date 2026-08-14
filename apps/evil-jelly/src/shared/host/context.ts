/**
 * Registers EvilJelly host I/O once per router turn so child agents read via getBinding()
 * instead of threading props (equipResource / expectResource).
 */

import { equipResource, expectResource } from "@rejelly/core";
import type { EvilJellyBindings } from "./bindings";

const HOST_BINDINGS_KEY = "evil_jelly:host_bindings";

/**
 * Call at the start of the root router handler (or headless CLI runners) before invoking child agents or expectResource.
 */
export async function setBinding(bindings: EvilJellyBindings): Promise<void> {
  await equipResource(HOST_BINDINGS_KEY, {
    create: async () => bindings,
    deps: [bindings],
    expose: true,
  });
}

/**
 * Resolved host I/O (input, conversation view, confirmation, observation) after setBinding in the same run.
 */
export function getBinding(): EvilJellyBindings {
  return expectResource<EvilJellyBindings>(HOST_BINDINGS_KEY);
}
