/**
 * Event Bus
 *
 * Provides pub/sub mechanism for framework events.
 */

import type { TraceEventEmitter } from "../context/type";
import type { TraceEvent, TraceEventMap, UnknownExtensionEvent } from "../domain/events";
import { logger } from "../shared/logger/instance";

// ============ Types ============

type Unsubscribe = () => void;

interface Subscription {
  id: number;
  eventType: string;
  callback: (event: TraceEvent) => void;
  once: boolean;
}

/**
 * Full event bus: pub/sub + emit. Use for default bus or when subscribers are needed.
 */
export interface EventBus extends TraceEventEmitter<TraceEvent> {
  // 1. Exact match for known events (highest priority for inference)
  subscribe<K extends keyof TraceEventMap>(
    eventType: K,
    callback: (event: TraceEventMap[K]) => void,
  ): Unsubscribe;
  // 2. Wildcard: callback receives union of all possible events
  subscribe(eventType: "*", callback: (event: TraceEvent) => void): Unsubscribe;
  // 3. Fallback: allow arbitrary custom event type strings, callback inferred as UnknownExtensionEvent
  subscribe(eventType: string & {}, callback: (event: UnknownExtensionEvent) => void): Unsubscribe;

  subscribeOnce<K extends keyof TraceEventMap>(
    eventType: K,
    callback: (event: TraceEventMap[K]) => void,
  ): Unsubscribe;
  subscribeOnce(eventType: "*", callback: (event: TraceEvent) => void): Unsubscribe;
  subscribeOnce(
    eventType: string & {},
    callback: (event: UnknownExtensionEvent) => void,
  ): Unsubscribe;

  subscribeMany(
    eventTypes: (keyof TraceEventMap | "*" | (string & {}))[],
    callback: (event: TraceEvent) => void,
  ): Unsubscribe;

  emit(event: TraceEvent): void;
  reset(): void;
}

// ============ Factory Function ============

/**
 * Create a new event bus instance (e.g. for isolated sandbox / trace capture)
 */
export function createEventBus(): EventBus {
  let subscriptions: Subscription[] = [];
  let nextId = 1;

  function subscribe(eventType: string, callback: (event: TraceEvent) => void): Unsubscribe {
    const id = nextId++;
    subscriptions.push({ id, eventType, callback, once: false });
    return () => {
      subscriptions = subscriptions.filter((s) => s.id !== id);
    };
  }

  function subscribeOnce(eventType: string, callback: (event: TraceEvent) => void): Unsubscribe {
    const id = nextId++;
    subscriptions.push({ id, eventType, callback, once: true });
    return () => {
      subscriptions = subscriptions.filter((s) => s.id !== id);
    };
  }

  function subscribeMany(
    eventTypes: (keyof TraceEventMap | "*" | (string & {}))[],
    callback: (event: TraceEvent) => void,
  ): Unsubscribe {
    const ids: number[] = [];
    for (const eventType of eventTypes) {
      const id = nextId++;
      ids.push(id);
      subscriptions.push({ id, eventType, callback, once: false });
    }
    return () => {
      subscriptions = subscriptions.filter((s) => !ids.includes(s.id));
    };
  }

  function emit(event: TraceEvent): void {
    // Snapshot to avoid infinite loop if a callback subscribes during this emit
    const currentSubs = [...subscriptions];

    for (const sub of currentSubs) {
      // Skip if this subscription was unsubscribed by another callback during this emit
      if (!subscriptions.some((s) => s.id === sub.id)) {
        continue;
      }

      if (sub.eventType === "*" || sub.eventType === event.type) {
        // Remove once-subscription BEFORE invoking callback to prevent infinite recursion:
        // if the callback emits the same event again, this subscription must not be seen.
        if (sub.once) {
          subscriptions = subscriptions.filter((s) => s.id !== sub.id);
        }

        try {
          sub.callback(event);
        } catch (e) {
          logger.warn("[Event Bus] callback error:", e);
        }
      }
    }
  }

  function reset(): void {
    subscriptions = [];
    nextId = 1;
  }

  // Internal implementation uses a single wide signature; type safety at call site
  // is provided by the EventBus interface overloads. Cast is intentional (not type-true).
  return {
    subscribe,
    subscribeOnce,
    subscribeMany,
    emit,
    reset,
  } as EventBus;
}

// ============ Global Instance (lazy) ============

/**
 * Versioned global key for cross-package singleton sharing.
 *
 * Keep the major version in the symbol name so incompatible core majors
 * can coexist in one process without corrupting each other's event bus.
 */
const EVENT_BUS_SYMBOL = Symbol.for("@rejelly/core/event-bus/v1");

/**
 * Get the global event bus instance (lazy initialization)
 *
 * Called by createAgent on first agent creation.
 */
export function getGlobalEventBus(): EventBus {
  const globalStore = globalThis as typeof globalThis & Record<symbol, EventBus | undefined>;

  if (!globalStore[EVENT_BUS_SYMBOL]) {
    globalStore[EVENT_BUS_SYMBOL] = createEventBus();
  }
  return globalStore[EVENT_BUS_SYMBOL] as EventBus;
}

/**
 * Reset global event bus (for testing)
 */
export function resetEventBus(): void {
  const globalStore = globalThis as typeof globalThis & Record<symbol, EventBus | undefined>;
  const bus = globalStore[EVENT_BUS_SYMBOL];
  if (bus) {
    bus.reset();
  }
  delete globalStore[EVENT_BUS_SYMBOL];
}

// ============ EventBus Resolution ============

/**
 * Context-like object that may have eventBus and parent reference
 */
interface EventBusContext {
  eventBus?: TraceEventEmitter<any>;
  parentContext?: EventBusContext;
}

/**
 * Find eventBus by traversing parent contexts recursively
 *
 * @param ctx - Context to start searching from
 * @returns TraceEventEmitter if found, undefined otherwise
 */
export function findEventBusInContext(
  ctx: EventBusContext | undefined,
): TraceEventEmitter<TraceEvent> | undefined {
  const visited = new Set<EventBusContext>();
  while (ctx) {
    if (visited.has(ctx)) {
      logger.warn("[Event Bus] Circular context reference detected");
      break;
    }
    visited.add(ctx);

    if (ctx.eventBus) {
      return ctx.eventBus as TraceEventEmitter<TraceEvent>;
    }
    ctx = ctx.parentContext;
  }
  return undefined;
}

/**
 * Resolve eventBus from candidates, falls back to global
 *
 * Takes any number of candidates and returns the first defined one,
 * or falls back to the global event bus.
 *
 * @param candidates - EventBus candidates in priority order
 * @returns First defined eventBus, or global if none provided
 *
 * @example
 * // Single candidate:
 * const eventBus = resolveEventBus(ctx.eventBus);
 *
 * // Multiple candidates (priority order):
 * const eventBus = resolveEventBus(config.eventBus, findEventBusInContext(parentCtx));
 */
export function resolveEventBus(
  ...candidates: (TraceEventEmitter<any> | undefined)[]
): TraceEventEmitter<TraceEvent> {
  for (const candidate of candidates) {
    if (candidate) return candidate as TraceEventEmitter<TraceEvent>;
  }
  return getGlobalEventBus();
}
