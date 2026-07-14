/**
 * Shared types for example modules.
 * Used by the central CLI runner to discover and run examples.
 */

export interface ExampleMeta {
  /** Module display name, e.g. "Planner & Search Agent" */
  name: string;
  /** Module description */
  description: string;
  /** Optional order weight for CLI menu sorting */
  order?: number;
}

export interface ExampleItem {
  /** Short title shown in menu */
  title: string;
  /** Optional detailed description */
  description?: string;
  /** The actual run logic */
  run: () => Promise<void>;
}

export interface ExampleModule {
  meta: ExampleMeta;
  examples: Record<string, ExampleItem>;
}

/**
 * Degraded format: module exports a single run function instead of { meta, examples }.
 * Runner will execute it directly without second-level menu.
 */
export type ExampleModuleOrSingle = ExampleModule | (() => Promise<void>);
