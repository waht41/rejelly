/**
 * Lifecycle and Control Flow Types
 *
 * Types related to Rejelly's special control flow mechanisms.
 */

import { REBORN_SIGNAL } from "../shared/symbols";

/**
 * Reborn signal type
 *
 * Returned by reborn() to trigger handler re-execution
 */
export interface RebornSignal<Props = unknown> {
  readonly [REBORN_SIGNAL]: true;
  readonly newProps?: Props;
}

/**
 * Result type for runWith function
 * Excludes RebornSignal from the return type since reborn signals are handled internally
 */
export type RunResult<R> = Promise<Exclude<R, RebornSignal<any>>>;
