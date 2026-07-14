/**
 * Proxy wrapper: overlay overrides on a source object without spreading.
 * Forwards un-overridden props to source; overridden methods see correct receiver (polymorphism).
 * Reference: @rejelly/core utils/proxy-wrapper.
 */
export function createProxyWrapper<T extends object, O extends object>(
  source: T,
  overrides: O,
): T & O {
  return new Proxy(source, {
    get(target, prop, receiver) {
      if (prop in overrides) {
        return Reflect.get(overrides, prop, receiver);
      }
      return Reflect.get(target, prop, receiver);
    },

    set(target, prop, value) {
      if (prop in overrides) {
        (overrides as Record<string | symbol, unknown>)[prop] = value;
        return true;
      }
      return Reflect.set(target, prop, value);
    },

    has(target, prop) {
      return prop in overrides || Reflect.has(target, prop);
    },

    ownKeys(target) {
      const sourceKeys = Reflect.ownKeys(target);
      const overrideKeys = Reflect.ownKeys(overrides);
      return Array.from(new Set([...sourceKeys, ...overrideKeys]));
    },

    getOwnPropertyDescriptor(target, prop) {
      if (prop in overrides) {
        const desc = Object.getOwnPropertyDescriptor(overrides, prop);
        if (desc) {
          desc.configurable = true;
          return desc;
        }
        return {
          value: (overrides as Record<string | symbol, unknown>)[prop],
          writable: true,
          enumerable: true,
          configurable: true,
        };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },

    getPrototypeOf(target) {
      return Reflect.getPrototypeOf(target);
    },
  }) as T & O;
}
