import type { ToolCallLoopMiddleware } from "../context/tool-call-loop";
import type { AgentContext } from "../context/type";
import { InvalidPromptRuntimeError } from "../domain/errors";
import type { Message } from "../domain/model";
import type { ToolDefinition } from "../domain/tool";
import { kRuntimeSeal } from "../shared/symbols";

/**
 * Consumable runtime snapshot threaded into `executeTurn` / `executeTools`.
 *
 * This is the "base & fork" view used during policy execution: fork a
 * `PromptContext` (which extends this) per node/turn and hand the SAME runtime
 * to both primitives, so the tool set offered to the model equals the set the
 * executor honors.
 *
 * Generation-global state — turn budget, journal, tracing span, abort signal —
 * is deliberately NOT here; it stays on the ambient `AgentContext` and is shared
 * by every fork of one generation, so forking can never fragment the budget or
 * lose the cache.
 *
 * Primitives only accept runtimes derived from the `PromptContext` created at
 * the policy barrier: the barrier attaches a hidden `RuntimeSeal` that forks
 * share by reference and that expires when the policy returns. Hand-built
 * runtime objects are rejected with `InvalidPromptRuntimeError` — write a small
 * custom policy (`createAgentPolicy`) instead of calling primitives elsewhere.
 */
export interface PromptRuntime {
  /** Base conversation this runtime was forked with (loop history source). */
  messages: Message[];
  system: Message[];
  instruction: Message[];
  tools: ToolDefinition[];
  toolCallLoopMiddlewares: ToolCallLoopMiddleware[];
}

/**
 * Capability that scopes a runtime to one policy execution. Created once per
 * policy invocation at the barrier, shared by reference across every fork of
 * that base `PromptContext`, and flipped dead in the barrier's `finally` so no
 * runtime outlives its policy. `owner` pins the runtime to the generation that
 * created it, so a runtime smuggled into another agent's call tree is rejected
 * even while the owning policy is still running.
 */
export interface RuntimeSeal {
  alive: boolean;
  owner: AgentContext;
}

/**
 * Attach a seal to a runtime as a symbol-keyed property. Symbol keys stay out
 * of `Object.keys` / JSON serialization (so the seal never leaks into traces or
 * snapshots) but ARE copied by object spread — a `{ ...runtime }` derivation
 * keeps working, carrying the same seal reference, which is semantically a
 * legitimate fork of the same policy execution.
 */
export function sealRuntime(runtime: PromptRuntime, seal: RuntimeSeal): void {
  (runtime as PromptRuntime & Record<symbol, unknown>)[kRuntimeSeal] = seal;
}

function getRuntimeSeal(runtime: PromptRuntime): RuntimeSeal | undefined {
  return (runtime as PromptRuntime & Record<symbol, unknown>)[kRuntimeSeal] as
    | RuntimeSeal
    | undefined;
}

/**
 * Gate at every primitive entry: the runtime must exist, carry a seal (i.e. be
 * derived from a policy's PromptContext), be alive (the owning policy has not
 * returned), and belong to the current agent generation.
 */
export function assertRuntimeUsable(
  runtime: PromptRuntime | undefined,
  ctx: AgentContext,
  apiName: string,
): asserts runtime is PromptRuntime {
  if (!runtime) {
    throw new InvalidPromptRuntimeError(apiName, "missing");
  }
  const seal = getRuntimeSeal(runtime);
  if (!seal) {
    throw new InvalidPromptRuntimeError(apiName, "unsealed");
  }
  if (!seal.alive) {
    throw new InvalidPromptRuntimeError(apiName, "expired");
  }
  if (seal.owner !== ctx) {
    throw new InvalidPromptRuntimeError(apiName, "foreign");
  }
}
