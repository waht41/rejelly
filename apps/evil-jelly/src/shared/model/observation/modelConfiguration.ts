import type { ModelAdapter } from "@rejelly/core";

export type SessionModelProtocol = "chat_completions" | "responses";

export interface SessionModelConfiguration {
  modelId: string;
  provider?: string;
  protocol: SessionModelProtocol;
  endpoint: string;
  reasoningEffort?: string;
}

const configurations = new WeakMap<ModelAdapter, Readonly<SessionModelConfiguration>>();

/** Attach non-secret configuration metadata to the composed adapter used by a run segment. */
export function registerSessionModelConfiguration(
  model: ModelAdapter,
  configuration: SessionModelConfiguration,
): ModelAdapter {
  configurations.set(model, Object.freeze({ ...configuration }));
  return model;
}

export function getSessionModelConfiguration(
  model: ModelAdapter,
): Readonly<SessionModelConfiguration> | undefined {
  return configurations.get(model);
}
