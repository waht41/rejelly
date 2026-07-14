/**
 * Internal Symbols for Rejelly
 *
 * Used to attach private metadata to agent functions
 * without exposing them in the public API.
 *
 * Plain `Symbol()` (not `Symbol.for`) on purpose: these keys are instance-private
 * and unforgeable, and objects from a duplicate copy of @rejelly/core are meant
 * to be *unrecognized* (property reads yield undefined) rather than risk reading
 * a value whose shape belongs to another version. Only the process-global
 * singleton slots (event bus, context store, logger) use versioned `Symbol.for`
 * keys, because those must be shared across copies.
 */

export const kHandler = Symbol("rejelly.handler");
export const kOriginalHandler = Symbol("rejelly.originalHandler");
export const kConfig = Symbol("rejelly.config");
/** Attached to augmented model for debug: list of applied ModelMiddleware (order preserved) */
export const kModelMiddlewares = Symbol("rejelly.modelMiddlewares");
/**
 * Attached to every PromptContext created at the policy barrier (and shared by
 * reference across its forks): the RuntimeSeal that scopes executeTurn /
 * executeTools to the owning policy execution. Symbol-keyed so it stays out of
 * the public PromptRuntime shape, JSON serialization, and trace snapshots.
 * As a forgery guard it relies on being a plain Symbol — do not switch to
 * Symbol.for, which would make the seal forgeable via the global registry.
 */
export const kRuntimeSeal = Symbol("rejelly.runtimeSeal");

// Reborn signal symbol
export const REBORN_SIGNAL = Symbol("rejelly.reborn");
